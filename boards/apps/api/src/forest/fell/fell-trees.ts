import { and, eq, inArray, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  fellingTable,
  sectorTable,
  sectorTreeTable,
  seedTable,
  timberLogTable,
} from "../../database/forest-schema";
import {
  columnTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { assertProjectAccess } from "../../project-access/assert-project-access";
import type { ForestActor } from "../actor";
import {
  type ApprovalAction,
  approvalParamsHash,
} from "../approval/approval-params";
import { ForestError } from "../forest-error";
import { writeJournal } from "../journal";
import type { Tx } from "../tx";
import { buildLog } from "./build-log";
import { buildSeeds, SEED_COMPRESSOR } from "./build-seeds";
import { collectTreeMaterial } from "./collect-tree-material";

export type FellInput = {
  workspaceId: string;
  actor: ForestActor;
  reason: string;
  // Required unless the actor is the owner in their own browser session.
  approvalId?: string;
  // The owner's «да» being applied by the server in this same transaction
  // (TB-102): its hash must still match the trees; nothing is spent here.
  appliedApproval?: { id: string; paramsHash: string };
  sanitize?: (text: string) => string;
} & ({ kind: "tree"; rootId: string } | { kind: "sector"; sectorId: string });

export type FellOutcome = Awaited<ReturnType<typeof fellInTx>>;

export type FellResult = {
  fellingId: string;
  logIds: string[];
  seedCount: number;
  taskCount: number;
};

async function sectorRoots(tx: Tx, workspaceId: string, sectorId: string) {
  const [sector] = await tx
    .select({ status: sectorTable.status })
    .from(sectorTable)
    .where(
      and(
        eq(sectorTable.id, sectorId),
        eq(sectorTable.workspaceId, workspaceId),
      ),
    )
    .for("update");
  if (!sector) throw new HTTPException(404, { message: "Sector not found" });
  if (sector.status !== "active") {
    throw new ForestError("felled", "sector is already felled");
  }
  const rows = await tx
    .select({ taskId: sectorTreeTable.taskId })
    .from(sectorTreeTable)
    .where(eq(sectorTreeTable.sectorId, sectorId));
  if (rows.length === 0) throw new ForestError("not_a_tree", "sector is empty");
  return rows.map((row) => row.taskId);
}

async function authorize(
  tx: Tx,
  input: FellInput,
  action: ApprovalAction,
  targetId: string,
  rootIds: string[],
) {
  if (input.appliedApproval) {
    const hash = approvalParamsHash(action, targetId, rootIds);
    if (hash !== input.appliedApproval.paramsHash) {
      throw new ForestError(
        "approval_mismatch",
        "the trees changed since the request; a fresh «да» is needed",
      );
    }
    return input.appliedApproval.id;
  }
  if (input.actor.kind === "owner-ui") return null;
  // TB-102 R-5: the server fells on the owner's «да» itself; an approvalId
  // from an agent gives no right any more.
  throw new ForestError(
    "approval_required",
    input.approvalId
      ? "the server fells on the owner's «да» itself; this call changes nothing"
      : "felling needs the owner's «да»: request an approval first",
  );
}

export async function fellInTx(
  tx: Tx,
  input: FellInput,
  action: ApprovalAction,
  targetId: string,
) {
  const rootIds =
    input.kind === "tree"
      ? [input.rootId]
      : await sectorRoots(tx, input.workspaceId, input.sectorId);
  const approvalId = await authorize(tx, input, action, targetId, rootIds);
  const { materials, taskIds } = await collectTreeMaterial(
    tx,
    input.workspaceId,
    rootIds,
  );
  await assertProjectAccess(input.actor.userId, [
    ...new Set(materials.flatMap((m) => m.tasks.map((task) => task.projectId))),
  ]);

  // Brevna gate (owner, 31.10; spec R-028): every card of every tree must sit in a
  // final column (done or already in the timber yard) at the moment of the
  // felling. collectTreeMaterial locked the rows FOR UPDATE above, so a card
  // pulled back to work between check and cut rolls the transaction back.
  const involvedProjectIds = [
    ...new Set(materials.flatMap((m) => m.tasks.map((task) => task.projectId))),
  ];
  const finalColumns = await tx
    .select({
      projectId: columnTable.projectId,
      slug: columnTable.slug,
      id: columnTable.id,
    })
    .from(columnTable)
    .where(
      and(
        inArray(columnTable.projectId, involvedProjectIds),
        eq(columnTable.isFinal, true),
      ),
    );
  const closedColumnByProject = new Map(
    finalColumns
      .filter((column) => column.slug === "closed")
      .map((column) => [column.projectId, column]),
  );
  const finalSlugsByProject = new Map<string, Set<string>>();
  for (const column of finalColumns) {
    const set = finalSlugsByProject.get(column.projectId) ?? new Set<string>();
    set.add(column.slug);
    finalSlugsByProject.set(column.projectId, set);
  }
  const taskById = new Map(
    materials.flatMap((material) =>
      material.tasks.map((task) => [task.id, task]),
    ),
  );
  for (const taskId of taskIds) {
    const task = taskById.get(taskId);
    if (!task) continue;
    const allowed = finalSlugsByProject.get(task.projectId);
    if (!allowed || !allowed.has(task.status)) {
      throw new ForestError(
        "not_ready",
        `Дерево нельзя срубить: карточка «${task.title}» ещё не в Done/Брёвнах`,
      );
    }
  }

  // Relations of the felled cards, read to publish the same link-drop
  // events as delete-task; the cards themselves stay (they move to Брёвна
  // below), so this stays informational for live boards.
  const relations = await tx
    .select({
      sourceTaskId: taskRelationTable.sourceTaskId,
      targetTaskId: taskRelationTable.targetTaskId,
    })
    .from(taskRelationTable)
    .where(
      or(
        inArray(taskRelationTable.sourceTaskId, taskIds),
        inArray(taskRelationTable.targetTaskId, taskIds),
      ),
    );

  const [felling] = await tx
    .insert(fellingTable)
    .values({
      workspaceId: input.workspaceId,
      kind: input.kind,
      sectorId: input.kind === "sector" ? input.sectorId : null,
      approvalId,
      reason: input.reason,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      treeCount: materials.length,
      taskCount: taskIds.length,
    })
    .returning({ id: fellingTable.id });
  if (!felling) throw new Error("felling insert returned nothing");

  const logIds: string[] = [];
  let seedCount = 0;
  for (const material of materials) {
    const draft = buildLog(material);
    const [log] = await tx
      .insert(timberLogTable)
      .values({
        ...draft,
        workspaceId: input.workspaceId,
        fellingId: felling.id,
      })
      .returning({ id: timberLogTable.id });
    if (!log) throw new Error("timber_log insert returned nothing");
    logIds.push(log.id);

    const seeds = buildSeeds(material, { sanitize: input.sanitize });
    if (seeds.length > 0) {
      await tx.insert(seedTable).values(
        seeds.map((seed) => ({
          ...seed,
          workspaceId: input.workspaceId,
          logId: log.id,
          sourceProjectIds: [material.root.projectId],
          compressor: SEED_COMPRESSOR,
        })),
      );
    }
    seedCount += seeds.length;
  }

  if (input.kind === "sector") {
    await tx
      .update(sectorTable)
      .set({ status: "felled", fellingId: felling.id })
      .where(eq(sectorTable.id, input.sectorId));
  }

  // Attachments are kept: felled cards stay readable in «Брёвна» (owner, 01.11).
  // Brevna (owner, 31.10; spec R-028): a felled tree stays on its boards — every
  // card moves to the project's closed column in the same transaction, so
  // the timber yard shows exactly what was cut. Relations, leases and labels
  // live on; the logs and seeds keep the compressed copy.
  for (const projectId of involvedProjectIds) {
    const closedColumn = closedColumnByProject.get(projectId);
    if (!closedColumn) continue;
    await tx
      .update(taskTable)
      .set({ status: "closed", columnId: closedColumn.id })
      .where(
        and(inArray(taskTable.id, taskIds), eq(taskTable.projectId, projectId)),
      );
  }

  await writeJournal(
    {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action,
      targetType: input.kind === "tree" ? "task" : "sector",
      targetId,
      outcome: "allowed",
      detail: `felled ${materials.length} tree(s), ${taskIds.length} task(s)`,
    },
    tx,
  );

  return {
    result: {
      fellingId: felling.id,
      logIds,
      seedCount,
      taskCount: taskIds.length,
    },
    tasks: materials.flatMap((material) => material.tasks),
    relations,
  };
}

// Fells one tree or a whole sector in one transaction (R-028, R-029, I7):
// copy into logs and seeds, then delete the tasks. Either all of it happens
// or nothing does; a refusal is journaled on its own.
export async function fellTrees(input: FellInput): Promise<FellResult> {
  const action: ApprovalAction =
    input.kind === "tree" ? "fell_tree" : "fell_sector";
  const targetId = input.kind === "tree" ? input.rootId : input.sectorId;

  let outcome: FellOutcome;
  try {
    outcome = await db.transaction((tx) =>
      fellInTx(tx, input, action, targetId),
    );
  } catch (error) {
    if (error instanceof ForestError) {
      await writeJournal({
        workspaceId: input.workspaceId,
        actor: input.actor,
        action,
        targetType: input.kind === "tree" ? "task" : "sector",
        targetId,
        outcome: "denied",
        detail: error.message,
      }).catch((journalError) => {
        console.error("Failed to journal a refused felling:", journalError);
      });
    }
    throw error;
  }

  await publishFelling(outcome, input.actor.userId);
  return outcome.result;
}

// Events go out only after the felling transaction commits.
export async function publishFelling(
  outcome: Pick<FellOutcome, "tasks" | "relations">,
  userId: string,
) {
  const felled = new Set(outcome.tasks.map((task) => task.id));
  for (const task of outcome.tasks) {
    await publishEvent("task.deleted", {
      taskId: task.id,
      projectId: task.projectId,
      userId,
      title: task.title,
    });
  }
  const projectOf = new Map(
    outcome.tasks.map((task) => [task.id, task.projectId]),
  );
  for (const relation of outcome.relations) {
    const felledEnd = felled.has(relation.sourceTaskId)
      ? relation.sourceTaskId
      : relation.targetTaskId;
    await publishEvent("task-relation.deleted", {
      projectId: projectOf.get(felledEnd),
      userId,
      taskId: felledEnd,
      sourceTaskId: relation.sourceTaskId,
      targetTaskId: relation.targetTaskId,
    });
  }
}
