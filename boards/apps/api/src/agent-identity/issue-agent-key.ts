import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
} from "drizzle-orm";
import { auth } from "../auth";
import db, { schema } from "../database";
import { ForestError } from "../forest/forest-error";
import { agentDisplayName, agentEmail } from "./agent-naming";
import { syncAgent } from "./sync-agent";

// A day: a key that leaks stops working by tomorrow, and the MCP bridge asks
// for a new one when the old one is refused.
export const AGENT_KEY_TTL_SECONDS = 24 * 60 * 60;
// Live keys an agent keeps besides the one being issued: a few bridges of the
// same session may run at once, and none of them should lose its key.
const KEPT_LIVE_KEYS = 3;
// Enabled agents per owner: a bridge looping over labels cannot fill the
// workspace with users, and every agent fits the owner's list to disable.
export const MAX_AGENTS_PER_OWNER = 50;

// The cap is the owner's to lift: only the owner can list and disable agents
// (agent-identity/index.ts), so the refusal must not read as the agent's job.
export function agentCapMessage(max: number = MAX_AGENTS_PER_OWNER): string {
  return `an owner keeps at most ${max} enabled agents; the owner disables the ones no longer working in the board's agent settings — an agent cannot`;
}
// Better Auth's default limit for key names.
const KEY_NAME_MAX = 32;

export type IssuedAgentKey = {
  agent: { id: string; name: string; harness: string; session: string };
  key: string;
  keyId: string;
  expiresAt: string | null;
};

type Identity = { ownerId: string; harness: string; session: string };
type IssueOptions = {
  permissions: Record<string, string[]> | null;
  expiresAt: Date | null;
};

function disabled(): never {
  throw new ForestError(
    "agent_forbidden",
    "this agent was disabled by its owner; it gets no new keys",
  );
}

async function findAgent(email: string) {
  const [row] = await db
    .select({
      id: schema.userTable.id,
      role: schema.userTable.role,
      name: schema.userTable.name,
      session: schema.agentProfileTable.session,
      disabledAt: schema.agentProfileTable.disabledAt,
    })
    .from(schema.userTable)
    .leftJoin(
      schema.agentProfileTable,
      eq(schema.agentProfileTable.userId, schema.userTable.id),
    )
    .where(eq(schema.userTable.email, email))
    .limit(1);
  return row;
}

async function assertMayAddAgent(ownerId: string) {
  const [owner] = await db
    .select({ isAnonymous: schema.userTable.isAnonymous })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, ownerId))
    .limit(1);
  if (!owner || owner.isAnonymous) {
    throw new ForestError("agent_forbidden", "a guest cannot have agents");
  }
  const [enabled] = await db
    .select({ n: count() })
    .from(schema.agentProfileTable)
    .where(
      and(
        eq(schema.agentProfileTable.ownerId, ownerId),
        isNull(schema.agentProfileTable.disabledAt),
      ),
    );
  if ((enabled?.n ?? 0) >= MAX_AGENTS_PER_OWNER) {
    throw new ForestError("agent_forbidden", agentCapMessage());
  }
}

// The stored agent of this owner, harness and session, or a new one. A
// disabled agent is refused before any write.
async function ensureAgentUser({ ownerId, harness, session }: Identity) {
  const email = agentEmail(ownerId, harness, session);
  let agent = await findAgent(email);
  if (!agent) {
    await assertMayAddAgent(ownerId);
    await db
      .insert(schema.userTable)
      .values({
        email,
        name: agentDisplayName(session, harness),
        emailVerified: false,
        role: "agent",
      })
      .onConflictDoNothing({ target: schema.userTable.email });
    agent = await findAgent(email);
  }
  // The domain is reserved for agents, so this is a broken row, not someone
  // else's account; refuse rather than hand out a person's key.
  if (!agent || agent.role !== "agent") {
    throw new ForestError("agent_forbidden", "agent identity is unavailable");
  }
  if (agent.disabledAt) disabled();
  if (!agent.session) {
    await db
      .insert(schema.agentProfileTable)
      .values({ userId: agent.id, ownerId, harness, session })
      .onConflictDoNothing({ target: schema.agentProfileTable.userId });
  }
  // The first label's case names the agent from then on.
  return {
    userId: agent.id,
    name: agent.name,
    session: agent.session ?? session,
  };
}

function keyName(name: string) {
  return name.length <= KEY_NAME_MAX
    ? name
    : `${name.slice(0, KEY_NAME_MAX - 1)}…`;
}

async function pruneKeys(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  agentId: string,
) {
  const owned = eq(schema.apikeyTable.referenceId, agentId);
  await tx
    .delete(schema.apikeyTable)
    .where(
      and(
        owned,
        isNotNull(schema.apikeyTable.expiresAt),
        lte(schema.apikeyTable.expiresAt, new Date()),
      ),
    );
  const live = await tx
    .select({ id: schema.apikeyTable.id })
    .from(schema.apikeyTable)
    .where(owned)
    .orderBy(desc(schema.apikeyTable.createdAt));
  const extra = live.slice(KEPT_LIVE_KEYS).map((k) => k.id);
  if (extra.length) {
    await tx
      .delete(schema.apikeyTable)
      .where(inArray(schema.apikeyTable.id, extra));
  }
}

// Gets or creates the agent of this owner, harness and session, brings its
// memberships in line with the owner's and issues it a fresh key.
export async function issueAgentKey(
  identity: Identity,
  { permissions, expiresAt: issuerExpiresAt }: IssueOptions,
): Promise<IssuedAgentKey> {
  const agent = await ensureAgentUser(identity);

  const outcome = await syncAgent(
    identity.ownerId,
    agent.userId,
    async (tx) => {
      await pruneKeys(tx, agent.userId);
      await tx
        .update(schema.agentProfileTable)
        .set({ lastIssuedAt: new Date() })
        .where(eq(schema.agentProfileTable.userId, agent.userId));
    },
  );
  if (outcome === "disabled") disabled();
  if (outcome === "missing") {
    throw new ForestError("agent_forbidden", "agent identity is unavailable");
  }

  const created = await auth.api.createApiKey({
    body: {
      userId: agent.userId,
      name: keyName(agent.name),
      expiresIn: AGENT_KEY_TTL_SECONDS,
      metadata: { agent: true, harness: identity.harness },
      ...(permissions ? { permissions } : {}),
    },
  });

  // Better Auth keeps keys for a day at least; one issued by a key that ends
  // sooner ends with it.
  let expiresAt = created.expiresAt ? new Date(created.expiresAt) : null;
  if (issuerExpiresAt && (!expiresAt || issuerExpiresAt < expiresAt)) {
    expiresAt = issuerExpiresAt;
    await db
      .update(schema.apikeyTable)
      .set({ expiresAt })
      .where(eq(schema.apikeyTable.id, created.id));
  }

  return {
    agent: {
      id: agent.userId,
      name: agent.name,
      harness: identity.harness,
      session: agent.session,
    },
    key: created.key,
    keyId: created.id,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}
