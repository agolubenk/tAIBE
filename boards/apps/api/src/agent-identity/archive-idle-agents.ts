import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  notExists,
  or,
} from "drizzle-orm";
import db, { schema } from "../database";
import { revokeUserConnections } from "../ws";
import { AGENT_IDLE_ARCHIVE_MS } from "./agent-limits";

// The most one run archives; about eight agents appear an hour (TB-100), so an
// hourly run stays far below it and a backlog drains over the next runs.
const BATCH = 200;

// TB-74: an agent nobody has used for 5 hours goes to the archive, so finished
// sessions stop holding places under the owner's cap. Its cards, comments and
// journal stay under its name, as when the owner disables it; its keys and
// sessions go. It comes back by itself when its session asks for a key again.
// Activity is its last key and its keys' last requests, or its creation.
// Disabled agents are the owner's and stay as they are.
export async function archiveIdleAgents(now = new Date()) {
  const cutoff = new Date(now.getTime() - AGENT_IDLE_ARCHIVE_MS);
  const profile = schema.agentProfileTable;
  const key = schema.apikeyTable;

  const archived = await db.transaction(async (tx) => {
    // Skip agents locked by a key being issued right now: they are active.
    const idle = await tx
      .select({ userId: profile.userId })
      .from(profile)
      .where(
        and(
          isNull(profile.disabledAt),
          isNull(profile.archivedAt),
          or(
            lt(profile.lastIssuedAt, cutoff),
            and(isNull(profile.lastIssuedAt), lt(profile.createdAt, cutoff)),
          ),
          notExists(
            tx
              .select({ id: key.id })
              .from(key)
              .where(
                and(
                  eq(key.referenceId, profile.userId),
                  gte(key.lastRequest, cutoff),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(profile.userId))
      .limit(BATCH)
      .for("update", { skipLocked: true });
    const ids = idle.map((row) => row.userId);
    if (!ids.length) return ids;
    await tx
      .update(profile)
      .set({ archivedAt: now })
      .where(inArray(profile.userId, ids));
    await tx.delete(key).where(inArray(key.referenceId, ids));
    // Agents never sign in; a session found here was not meant to exist.
    await tx
      .delete(schema.sessionTable)
      .where(inArray(schema.sessionTable.userId, ids));
    return ids;
  });

  await Promise.all(archived.map((id) => revokeUserConnections(id)));
  return { archived: archived.length };
}
