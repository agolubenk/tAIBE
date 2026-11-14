import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import db from "../database";
import { agentJournalTable } from "../database/forest-schema";
import {
  projectTable,
  taskTable,
  workspaceUserTable,
} from "../database/schema";
import type { ForestActor } from "../forest/actor";
import { callDetail, callTarget, toolTarget } from "../mcp/call-detail";
import { projectAccessCondition } from "../project-access/project-access-condition";
import type { McpCallInput } from "./schema";

// The cards the actor may open: a member of the card's workspace with access
// to its project. A reported call is filed under a card only then.
async function openableCards(userId: string, ids: string[]) {
  if (ids.length === 0) return new Set<string>();
  const rows = await db
    .select({ id: taskTable.id })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .innerJoin(
      workspaceUserTable,
      and(
        eq(workspaceUserTable.workspaceId, projectTable.workspaceId),
        eq(workspaceUserTable.userId, userId),
      ),
    )
    .where(
      and(
        inArray(taskTable.id, ids),
        projectAccessCondition(userId, projectTable.id),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

// The row id is the caller's call id hashed with the actor: a batch sent
// again lands on the rows it already wrote, and no actor can name another
// actor's rows. The primary key keeps it unique, so no new index is needed.
export function journalRowId(actorId: string, callId: string) {
  const hash = createHash("sha256").update(`${actorId}\n${callId}`);
  return `mcp_${hash.digest("hex").slice(0, 32)}`;
}

// TB-135 (R-036): calls a stdio MCP server made, journaled as the remote /mcp
// journals its own (callDetail, callTarget), under the actor of the key that
// sent them. The server did not see these calls, so a card is checked first.
export async function recordCalls(actor: ForestActor, calls: McpCallInput[]) {
  const unique = [...new Map(calls.map((call) => [call.id, call])).values()];
  const targets = unique.map((call) => callTarget(call));
  const cardIds = targets
    .filter((target) => target.targetType === "task")
    .map((target) => target.targetId);
  const openable = await openableCards(actor.userId, [...new Set(cardIds)]);

  const rows = unique.map((call, index) => {
    const target = targets[index] ?? toolTarget(call);
    const filed =
      target.targetType === "task" && !openable.has(target.targetId)
        ? toolTarget(call)
        : target;
    return {
      id: journalRowId(actor.id, call.id),
      workspaceId: null,
      actorKind: actor.kind,
      actorId: actor.id,
      actorName: actor.name,
      action: "mcp.call",
      ...filed,
      outcome: call.ok ? ("allowed" as const) : ("denied" as const),
      detail: callDetail(call).slice(0, 2000),
    };
  });

  const written = await db
    .insert(agentJournalTable)
    .values(rows)
    .onConflictDoNothing({ target: agentJournalTable.id })
    .returning({ id: agentJournalTable.id });
  return { received: calls.length, journaled: written.length };
}
