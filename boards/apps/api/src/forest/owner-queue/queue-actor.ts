import { and, eq } from "drizzle-orm";
import db from "../../database";
import { userTable, workspaceUserTable } from "../../database/schema";
import type { ForestActor } from "../actor";
import { writeJournal } from "../journal";

export const OWNER_QUEUE_ACTOR_ID = "owner-queue";

// R-3: the owner's answer read from the queue acts as the workspace owner.
// This actor is built only here, from the server's own sync; no route and no
// token resolves to it (forest/actor.ts).
export async function ownerQueueActor(
  workspaceId: string,
): Promise<ForestActor | null> {
  const [owner] = await db
    .select({ userId: workspaceUserTable.userId, name: userTable.name })
    .from(workspaceUserTable)
    .innerJoin(userTable, eq(workspaceUserTable.userId, userTable.id))
    .where(
      and(
        eq(workspaceUserTable.workspaceId, workspaceId),
        eq(workspaceUserTable.role, "owner"),
      ),
    )
    .limit(1);
  if (!owner) return null;
  return {
    kind: "owner-queue",
    id: OWNER_QUEUE_ACTOR_ID,
    name: `${owner.name} (очередь)`,
    userId: owner.userId,
  };
}

// The sync's own journal rows (queue.*): who wrote them is t-boards itself.
const SYNC_ACTOR: ForestActor = {
  kind: "owner-queue",
  id: OWNER_QUEUE_ACTOR_ID,
  name: "t-boards (очередь)",
  userId: "",
};

export async function journalQueue(
  workspaceId: string | null,
  action: string,
  targetId: string,
  detail: string,
  outcome: "allowed" | "denied" = "denied",
) {
  await writeJournal({
    workspaceId,
    actor: SYNC_ACTOR,
    action,
    targetType: "approval",
    targetId,
    outcome,
    detail,
  });
}
