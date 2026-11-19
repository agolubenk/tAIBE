import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable } from "../../database/schema";
import { resolveDestinationStatus } from "../../task/resolve-destination-status";
import { isClosingStatus } from "./closing-status";
import { projectWorkspace } from "./load-task";

type MovedTask = {
  projectId: string;
  workspaceId: string;
  status: string;
  columnId: string | null;
};

export type MoveFacts = {
  landing: string;
  closes: boolean;
  reopens: boolean;
  // The rest names the way round a refused move (moveRoute).
  wasClosed: boolean;
  fromFinal: boolean;
  landingFinal: boolean;
};

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
// the move itself (404 for a project of another workspace, 400 for a status
// it lacks) and writes nothing; the guard does not read that project's
// columns, so its answer tells nothing about them.
export async function moveFacts(
  task: MovedTask,
  destinationProjectId: string,
  requested: string | undefined,
): Promise<MoveFacts | null> {
  if ((await projectWorkspace(destinationProjectId)) !== task.workspaceId) {
    return null;
  }
  const landing = await resolveDestinationStatus(
    destinationProjectId,
    task.status,
    requested,
  ).catch((error: unknown) => {
    if (error instanceof HTTPException) return null;
    throw error;
  });
  if (!landing) return null;
  const [wasClosed, fromFinal] = await Promise.all([
    isClosingStatus(task.projectId, task.status),
    inFinalColumn(task),
  ]);
  const landingFinal = landing.isFinal && landing.slug !== LOGS;
  const stays = wasClosed && fromFinal && landingFinal;
  const closes =
    !stays && (await isClosingStatus(destinationProjectId, landing.slug));
  return {
    landing: landing.slug,
    closes,
    reopens: wasClosed && !stays && !closes,
    wasClosed,
    fromFinal,
    landingFinal,
  };
}

// The way round a move that needs a «да» (TB-80, TB-82). The owner's «да»
// sets a status in the card's current project and moves nothing, so every
// step names the project it runs in, and each step is one the guard lets
// through: an open card moves between open columns, a card in a final column
// moves into a final column.
export function moveRoute(facts: MoveFacts, url: string): string {
  const ask = (action: string, where: string) =>
    `ask ${action} ${where} (POST ${url})`;
  if (facts.reopens) {
    return `this move reopens the card: ${ask("reopen_task", "in its own project with an open status of that project")}, then move it`;
  }
  if (!facts.wasClosed) {
    return `this move closes the card: move it into an open column of the destination first (destinationStatus), then ${ask("close_task", "in the destination")}`;
  }
  const steps = [
    ...(facts.fromFinal
      ? []
      : [
          ask(
            "close_task",
            "in its own project with a final status of that project",
          ),
        ]),
    "move it into a final column of the destination",
    ...(facts.landingFinal
      ? []
      : [ask("close_task", `in the destination for «${facts.landing}»`)]),
  ];
  return `a closed card moves without a «да» only from a final column of its project into a final column of the other: ${steps.join(", then ")}`;
}
