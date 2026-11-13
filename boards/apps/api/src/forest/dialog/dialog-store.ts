import { eq } from "drizzle-orm";
import type { Context } from "hono";
import db from "../../database";
import { taskLeaseTable } from "../../database/forest-schema";
import { taskTable } from "../../database/schema";
import { resolveForestActor } from "../actor";
import { readAgentHeaders } from "../agent-guard/agent-headers";
import { isClosingStatus } from "../agent-guard/closing-status";
import { cardStage } from "../card-fill/card-stage";
import {
  type DialogLease,
  type DialogMark,
  decideDialogMark,
  isDialogOpen,
  readDialogMark,
} from "./session-dialog";

async function readLease(taskId: string): Promise<DialogLease | null> {
  const [lease] = await db
    .select({
      holderId: taskLeaseTable.holderId,
      groupKey: taskLeaseTable.groupKey,
      fencingToken: taskLeaseTable.fencingToken,
      expiresAt: taskLeaseTable.expiresAt,
    })
    .from(taskLeaseTable)
    .where(eq(taskLeaseTable.taskId, taskId));
  return lease ?? null;
}

// The dialog a new comment joins: only an agent session of a live group lease.
export async function dialogMarkFor(
  c: Context,
  taskId: string,
): Promise<DialogMark | null> {
  let actor: ReturnType<typeof resolveForestActor>;
  try {
    actor = resolveForestActor(c);
  } catch {
    return null;
  }
  if (actor.kind !== "agent") return null;
  return decideDialogMark(
    await readLease(taskId),
    actor,
    readAgentHeaders(c).groupKey,
    new Date(),
  );
}

async function isCardInWork(taskId: string) {
  const [task] = await db
    .select({ status: taskTable.status, projectId: taskTable.projectId })
    .from(taskTable)
    .where(eq(taskTable.id, taskId));
  if (!task || cardStage(task.status) === "review") return false;
  return !(await isClosingStatus(task.projectId, task.status));
}

// Adds `open` to the dialog mark of each dialog comment of one task's feed.
// Two reads, and only when the feed has a dialog.
export async function markOpenDialogs<T extends { eventData: unknown }>(
  taskId: string,
  activities: T[],
): Promise<T[]> {
  if (!activities.some((activity) => readDialogMark(activity.eventData))) {
    return activities;
  }
  const [lease, inWork] = await Promise.all([
    readLease(taskId),
    isCardInWork(taskId),
  ]);
  const now = new Date();
  return activities.map((activity) => {
    const mark = readDialogMark(activity.eventData);
    if (!mark) return activity;
    const open = isDialogOpen(mark, lease, { inWork }, now);
    return {
      ...activity,
      eventData: {
        ...(activity.eventData as Record<string, unknown>),
        dialog: { ...mark, open },
      },
    };
  });
}
