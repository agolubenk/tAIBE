import { createHash } from "node:crypto";
import {
  and,
  eq,
  exists,
  getTableColumns,
  gt,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db, { schema } from "../database";
import { evaluateApiKeyUsage } from "./api-key-usage";
import { parseApiKeyAccess } from "./api-key-access";
import { parseApiKeyWorkspaceScope } from "./api-key-workspace-scope";
import { notBannedCondition } from "./user-ban";

async function hashApiKey(key: string): Promise<string> {
  const hash = createHash("sha256").update(key).digest();
  return hash
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function parsePermissions(raw: string | null): Record<string, string[]> | null {
  if (raw === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const permissions: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!Array.isArray(actions)) return {};
    if (actions.some((action) => typeof action !== "string")) return {};
    permissions[resource] = actions as string[];
  }
  return permissions;
}

const keyOwnerId = sql`coalesce(${schema.apikeyTable.referenceId}, ${schema.apikeyTable.userId})`;

// R-010: a key of an agent user acts under the agent's own name. Read with
// the key itself, so telling an agent apart costs no extra round trip.
const keyOwnerRole = sql<
  string | null
>`(select ${schema.userTable.role} from ${schema.userTable} where ${schema.userTable.id} = ${keyOwnerId})`;

const keyColumns = {
  ...getTableColumns(schema.apikeyTable),
  ownerRole: keyOwnerRole,
  ownerName: sql<
    string | null
  >`(select ${schema.userTable.name} from ${schema.userTable} where ${schema.userTable.id} = ${keyOwnerId})`,
};

function keyAgent(row: {
  ownerRole: string | null;
  ownerName: string | null;
}): { name: string } | null {
  return row.ownerRole === "agent" ? { name: row.ownerName ?? "agent" } : null;
}

const agentOwner = alias(schema.userTable, "agent_owner");

// R-010: an agent works only while it is active and its owner may work. A
// disabled or archived agent (TB-74), a banned owner or one who deleted the
// account voids every key of the agent at once, whatever the key's own
// expiry; an archived agent comes back through a new key only.
function agentMayWork() {
  return or(
    sql`${keyOwnerRole} is distinct from 'agent'`,
    exists(
      db
        .select({ id: schema.agentProfileTable.userId })
        .from(schema.agentProfileTable)
        .innerJoin(
          agentOwner,
          eq(agentOwner.id, schema.agentProfileTable.ownerId),
        )
        .where(
          and(
            eq(schema.agentProfileTable.userId, keyOwnerId),
            isNull(schema.agentProfileTable.disabledAt),
            isNull(schema.agentProfileTable.archivedAt),
            notBannedCondition(agentOwner),
          ),
        ),
    ),
  );
}

function activeApiKey(hashedKey: string) {
  return and(
    eq(schema.apikeyTable.key, hashedKey),
    eq(schema.apikeyTable.enabled, true),
    // Fail closed even before legacy databases finish the repair migration.
    exists(
      db
        .select({ id: schema.userTable.id })
        .from(schema.userTable)
        .where(and(eq(schema.userTable.id, keyOwnerId), notBannedCondition())),
    ),
    agentMayWork(),
    or(
      isNull(schema.apikeyTable.expiresAt),
      gt(schema.apikeyTable.expiresAt, new Date()),
    ),
  );
}

async function checkApiKey(hashedKey: string) {
  const [row] = await db
    .select(keyColumns)
    .from(schema.apikeyTable)
    .where(activeApiKey(hashedKey))
    .limit(1);
  if (!row) return null;
  const { ownerRole: _role, ownerName: _name, ...apiKey } = row;

  const usage = evaluateApiKeyUsage(apiKey, new Date(), false);
  if (usage.status !== "valid") return usage;
  return {
    status: "valid" as const,
    rateLimit: usage.rateLimit,
    key: {
      ...apiKey,
      userId: apiKey.referenceId ?? apiKey.userId ?? "",
      enabled: apiKey.enabled ?? false,
      permissions: parsePermissions(apiKey.permissions),
      metadata: null,
      workspaceScope: parseApiKeyWorkspaceScope(apiKey.metadata),
      access: parseApiKeyAccess(apiKey.metadata),
      agent: keyAgent(row),
    },
  };
}

export async function verifyApiKey(
  key: string,
  options: { consume?: boolean } = {},
) {
  const hashedKey = await hashApiKey(key);
  if (options.consume === false) return checkApiKey(hashedKey);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select(keyColumns)
      .from(schema.apikeyTable)
      .where(activeApiKey(hashedKey))
      .limit(1)
      .for("update");

    if (!row) {
      return null;
    }
    const { ownerRole: _role, ownerName: _name, ...apiKey } = row;
    // A key may expire while SELECT waits for another request's row lock.
    const now = new Date();
    if (apiKey.expiresAt && apiKey.expiresAt <= now) return null;

    // Locking the key serializes quota/refill and window accounting across API
    // instances. Neither a stale lookup nor a rejected request can restore quota.
    const usage = evaluateApiKeyUsage(apiKey, now, true);
    if (usage.status !== "valid") return usage;

    const { remaining, lastRefillAt, requestCount, rateLimit } = usage;
    await tx
      .update(schema.apikeyTable)
      .set({
        remaining,
        lastRefillAt,
        requestCount,
        lastRequest: now,
        updatedAt: now,
      })
      .where(eq(schema.apikeyTable.id, apiKey.id));

    return {
      status: "valid" as const,
      rateLimit,
      key: {
        id: apiKey.id,
        userId: apiKey.referenceId ?? apiKey.userId ?? "",
        name: apiKey.name,
        prefix: apiKey.prefix,
        start: apiKey.start,
        enabled: apiKey.enabled ?? false,
        expiresAt: apiKey.expiresAt,
        permissions: parsePermissions(apiKey.permissions),
        refillInterval: apiKey.refillInterval,
        refillAmount: apiKey.refillAmount,
        lastRefillAt,
        rateLimitEnabled: apiKey.rateLimitEnabled,
        rateLimitTimeWindow: apiKey.rateLimitTimeWindow,
        rateLimitMax: apiKey.rateLimitMax,
        requestCount,
        remaining,
        lastRequest: now,
        metadata: apiKey.metadata
          ? (JSON.parse(apiKey.metadata) as Record<string, unknown>)
          : null,
        workspaceScope: parseApiKeyWorkspaceScope(apiKey.metadata),
        access: parseApiKeyAccess(apiKey.metadata),
        agent: keyAgent(row),
      },
    };
  });
}

export async function readApiKeyCheck(key: string) {
  try {
    return await verifyApiKey(key, { consume: false });
  } catch (error) {
    console.error("Failed to read API key usage:", error);
    return null;
  }
}
