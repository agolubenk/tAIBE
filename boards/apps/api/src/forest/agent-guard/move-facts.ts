import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable } from "../../database/schema";
import { resolveDestinationStatus } from "../../task/resolve-destination-status";
import { isClosingStatus } from "./closing-status";

type MovedTask = { projectId: string; status: string; columnId: string | null };

export type MoveFacts = { landing: string; closes: boolean; reopens: boolean };

// «Брёвна» are terminal (R-8): a move neither takes a card out of them nor
// puts it in without the owner's «да».
const LOGS = "closed";

// The card sits in a final column of its own project by its column, not only
// by its status: «archived» and the owner's stages have no final column.
async function inFinalColumn(task: MovedTask) {
  if (!task.columnId || task.status === LOGS) return false;
  const [column] = await db
    .select({
      isFinal: columnTable.isFinal,
      slug: columnTable.slug,
      projectId: columnTable.projectId,
    })
    .from(columnTable)
    .where(eq(columnTable.id, task.columnId))
    .limit(1);
  return (
    column?.isFinal === true &&
    column.projectId === task.projectId &&
    column.slug === task.status
  );
}

// A move to another project (TB-80). The card lands where move-task puts it:
// the requested status, else its slug, else the first column. Closing and
// reopening compare the two projects, so the same slug or no status at all
// can close or reopen a card too. A card already in a final column that lands
// in a final column stays closed and needs no «да». null: move-task refuses
// the move itself.
export async function moveFacts(
  task: MovedTask,
  destinationProjectId: string,
  requested: string | undefined,
): Promise<MoveFacts | null> {
  const landing = await resolveDestinationStatus(
    destinationProjectId,
    task.status,
    requested,
  ).catch((error: unknown) => {
    if (error instanceof HTTPException) return null;
    throw error;
  });
  if (!landing) return null;
  const wasClosed = await isClosingStatus(task.projectId, task.status);
  if (
    wasClosed &&
    landing.isFinal &&
    landing.slug !== LOGS &&
    (await inFinalColumn(task))
  ) {
    return { landing: landing.slug, closes: false, reopens: false };
  }
  const closes = await isClosingStatus(destinationProjectId, landing.slug);
  return { landing: landing.slug, closes, reopens: wasClosed && !closes };
}
