import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { revokeUserConnections } from "../ws";

// Disabling an agent revokes every key it holds and refuses new ones; its
// cards, comments and journal stay under its name. It is the owner's switch
// and wins over the archive. Enabling a disabled agent moves it to the
// archive (TB-74): it takes a place under the cap only when its session asks
// for a key again. Enabling an active or archived agent changes nothing.
export async function setAgentEnabled(
  ownerId: string,
  agentId: string,
  enabled: boolean,
) {
  const result = await db.transaction(async (tx) => {
    const [profile] = await tx
      .select({
        disabledAt: schema.agentProfileTable.disabledAt,
        archivedAt: schema.agentProfileTable.archivedAt,
      })
      .from(schema.agentProfileTable)
      .where(
        and(
          eq(schema.agentProfileTable.userId, agentId),
          eq(schema.agentProfileTable.ownerId, ownerId),
        ),
      )
      .for("update");
    if (!profile) {
      throw new HTTPException(404, { message: "Agent not found" });
    }
    const owned = eq(schema.agentProfileTable.userId, agentId);
    if (enabled) {
      if (profile.disabledAt) {
        await tx
          .update(schema.agentProfileTable)
          .set({ disabledAt: null, archivedAt: new Date() })
          .where(owned);
      }
      const archived = Boolean(profile.disabledAt ?? profile.archivedAt);
      return { id: agentId, enabled, archived, revokedKeys: 0 };
    }
    await tx
      .update(schema.agentProfileTable)
      .set({ disabledAt: new Date(), archivedAt: null })
      .where(owned);
    const revoked = await tx
      .delete(schema.apikeyTable)
      .where(eq(schema.apikeyTable.referenceId, agentId))
      .returning({ id: schema.apikeyTable.id });
    // Agents never sign in; a session found here was not meant to exist.
    await tx
      .delete(schema.sessionTable)
      .where(eq(schema.sessionTable.userId, agentId));
    return {
      id: agentId,
      enabled,
      archived: false,
      revokedKeys: revoked.length,
    };
  });
  if (!enabled) await revokeUserConnections(agentId);
  return result;
}
