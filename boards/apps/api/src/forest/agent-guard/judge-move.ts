import { asc, eq } from "drizzle-orm";
import db from "../../database";
import { columnTable } from "../../database/schema";
import { pickDestinationColumn } from "../../task/controllers/pick-destination-column";
import { isClosingStatus } from "./closing-status";
import { projectWorkspace } from "./load-task";

export type Stage = { slug: string; closed: boolean };

export type MoveVerdict =
  | { kind: "allow"; status: string | undefined }
  | { kind: "deny"; reason: string };

// TB-82. A move to another project keeps the card open, or closed in the
// same stage. The owner's «да» is applied in the card's current project and
// does not move the card, so a move that closes the card, reopens it or
// changes its closing stage gets the way round instead of an approval.
export function judgeLanding(from: Stage, to: Stage): MoveVerdict {
  if (!from.closed && !to.closed) return { kind: "allow", status: to.slug };
  if (from.closed && to.closed && from.slug === to.slug) {
    return { kind: "allow", status: to.slug };
  }
  if (!from.closed) {
    return {
      kind: "deny",
      reason: `the move would close the card in «${to.slug}»; move it to an open column (destinationStatus), then ask close_task in the new project`,
    };
  }
  if (!to.closed) {
    return {
      kind: "deny",
      reason: `the move would reopen the card in «${to.slug}»; ask reopen_task in its project first, then move it`,
    };
  }
  return {
    kind: "deny",
    reason: `the move would change the closing stage «${from.slug}» → «${to.slug}»; move it with destinationStatus «${from.slug}», or ask reopen_task first`,
  };
}

// The guard judges the column the move writes: the requested one, else the
// card's slug, else the first column — the same pick as move-task.
export async function judgeMove(
  task: { projectId: string; status: string; workspaceId: string },
  destinationProjectId: string,
  requestedStatus: string | undefined,
): Promise<MoveVerdict> {
  // move-task answers 400 to a move inside the card's project and 404 to a
  // project of another workspace, and writes nothing. Judging such a move
  // would show the other project's columns.
  if (
    destinationProjectId === task.projectId ||
    (await projectWorkspace(destinationProjectId)) !== task.workspaceId
  ) {
    return { kind: "allow", status: undefined };
  }
  const columns = await db
    .select({ slug: columnTable.slug })
    .from(columnTable)
    .where(eq(columnTable.projectId, destinationProjectId))
    .orderBy(asc(columnTable.position));
  const landing = pickDestinationColumn(columns, task.status, requestedStatus);
  // No such column, or no columns: move-task answers 400 and writes nothing.
  if (!landing) return { kind: "allow", status: requestedStatus };
  const [fromClosed, toClosed] = await Promise.all([
    isClosingStatus(task.projectId, task.status),
    isClosingStatus(destinationProjectId, landing.slug),
  ]);
  return judgeLanding(
    { slug: task.status, closed: fromClosed },
    { slug: landing.slug, closed: toClosed },
  );
}
