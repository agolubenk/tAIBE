import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema } from "../database";

const MAX_AGENTS = 100;

const iso = (date: Date | null) => (date ? date.toISOString() : null);

function agentRows(where: SQL | undefined) {
  return db
    .select({
      id: schema.agentProfileTable.userId,
      name: schema.userTable.name,
      harness: schema.agentProfileTable.harness,
      session: schema.agentProfileTable.session,
      disabledAt: schema.agentProfileTable.disabledAt,
      archivedAt: schema.agentProfileTable.archivedAt,
      lastIssuedAt: schema.agentProfileTable.lastIssuedAt,
      createdAt: schema.agentProfileTable.createdAt,
    })
    .from(schema.agentProfileTable)
    .innerJoin(
      schema.userTable,
      eq(schema.userTable.id, schema.agentProfileTable.userId),
    )
    .where(where)
    .orderBy(
      sql`${schema.agentProfileTable.disabledAt} is null desc`,
      sql`${schema.agentProfileTable.lastIssuedAt} desc nulls last`,
      desc(schema.agentProfileTable.createdAt),
    )
    .limit(MAX_AGENTS);
}

// The owner's agents with their live keys: what each one is called, when it
// last asked for a key and used one. Active agents come first, then the
// archive, then the disabled ones, recently active first in each. The archive
// grows by itself (TB-74), so it is read on its own and never pushes the
// owner's active or disabled agents off the list. Key secrets never leave
// the server.
export async function listAgents(ownerId: string) {
  const owned = eq(schema.agentProfileTable.ownerId, ownerId);
  const [kept, archived] = await Promise.all([
    agentRows(and(owned, isNull(schema.agentProfileTable.archivedAt))),
    agentRows(and(owned, isNotNull(schema.agentProfileTable.archivedAt))),
  ]);
  const agents = [
    ...kept.filter((agent) => !agent.disabledAt),
    ...archived,
    ...kept.filter((agent) => agent.disabledAt),
  ];

  const keys = agents.length
    ? await db
        .select({
          id: schema.apikeyTable.id,
          agentId: schema.apikeyTable.referenceId,
          start: schema.apikeyTable.start,
          createdAt: schema.apikeyTable.createdAt,
          lastRequest: schema.apikeyTable.lastRequest,
          expiresAt: schema.apikeyTable.expiresAt,
        })
        .from(schema.apikeyTable)
        .where(
          and(
            inArray(
              schema.apikeyTable.referenceId,
              agents.map((a) => a.id),
            ),
            eq(schema.apikeyTable.enabled, true),
            or(
              isNull(schema.apikeyTable.expiresAt),
              gt(schema.apikeyTable.expiresAt, new Date()),
            ),
          ),
        )
    : [];

  return agents.map((agent) => ({
    ...agent,
    disabledAt: iso(agent.disabledAt),
    archivedAt: iso(agent.archivedAt),
    lastIssuedAt: iso(agent.lastIssuedAt),
    createdAt: agent.createdAt.toISOString(),
    keys: keys
      .filter((k) => k.agentId === agent.id)
      .map(({ agentId: _, ...k }) => ({
        ...k,
        createdAt: k.createdAt.toISOString(),
        lastRequest: iso(k.lastRequest),
        expiresAt: iso(k.expiresAt),
      })),
  }));
}
