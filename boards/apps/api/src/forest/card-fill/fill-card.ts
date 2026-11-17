import { and, eq, inArray } from "drizzle-orm";
import createComment from "../../activity/controllers/create-comment";
import { authorOfActor } from "../author-kind";
import db from "../../database";
import { agentProfileTable } from "../../database/forest-schema";
import {
  columnTable,
  externalLinkTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import createExternalLink from "../../external-link/controllers/create-external-link";
import { publishTaskMutation } from "../../task/controllers/task-mutation-effects";
import { withLockedTask } from "../../task/controllers/with-locked-task";
import {
  assertAssignableUser,
  getProjectWorkspaceId,
} from "../../utils/assert-assignable-user";
import { pipelineEnabled } from "../../pipeline-settings/store";
import type { ForestActor } from "../actor";
import { cardStage } from "./card-stage";

export type CardMove = {
  taskId: string;
  projectId: string;
  from: string;
  to: string;
  actor: ForestActor;
  note: string | null;
  link: string | null;
};

async function addLink(taskId: string, url: string, userId: string) {
  const [existing] = await db
    .select({ id: externalLinkTable.id })
    .from(externalLinkTable)
    .where(
      and(eq(externalLinkTable.taskId, taskId), eq(externalLinkTable.url, url)),
    )
    .limit(1);
  if (!existing) await createExternalLink({ taskId, url, userId });
}

// Whoever starts or hands over the work holds the card, from the day it
// started; fields someone already set stay as they are.
async function takeCard(taskId: string, userId: string) {
  const { before, after } = await withLockedTask(taskId, async (tx, task) => {
    const set: Partial<typeof taskTable.$inferInsert> = {};
    if (!task.startDate) set.startDate = new Date();
    if (!task.userId) {
      const assignable = await assertAssignableUser(
        userId,
        await getProjectWorkspaceId(task.projectId, tx),
        task.projectId,
        tx,
      )
        .then(() => true)
        .catch(() => false);
      if (assignable) set.userId = userId;
    }
    if (Object.keys(set).length === 0) return task;
    const [updated] = await tx
      .update(taskTable)
      .set(set)
      .where(eq(taskTable.id, taskId))
      .returning();
    return updated ?? task;
  });
  if (before === after) return;
  await publishTaskMutation(before, after, userId, { fields: ["userId"] });
  // A start date has no field event of its own; this one makes open tabs
  // refetch the card instead of showing it empty until a reload.
  if (!before.startDate && after.startDate) {
    await publishEvent("task.updated", {
      taskId: after.id,
      projectId: after.projectId,
      title: after.title,
      status: after.status,
      userId,
    });
  }
}

function escapeAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// The person an agent works for hears of every move it makes.
async function ownerMention(agentUserId: string) {
  const [owner] = await db
    .select({ id: userTable.id, name: userTable.name })
    .from(agentProfileTable)
    .innerJoin(userTable, eq(userTable.id, agentProfileTable.ownerId))
    .where(eq(agentProfileTable.userId, agentUserId))
    .limit(1);
  if (!owner || owner.id === agentUserId) return "";
  return `<kaneo-mention id="${escapeAttr(owner.id)}" label="${escapeAttr(owner.name)}"></kaneo-mention> `;
}

async function columnNames(projectId: string, slugs: string[]) {
  const rows = await db
    .select({ slug: columnTable.slug, name: columnTable.name })
    .from(columnTable)
    .where(
      and(
        eq(columnTable.projectId, projectId),
        inArray(columnTable.slug, slugs),
      ),
    );
  return new Map(rows.map((row) => [row.slug, row.name]));
}

async function commentMove(move: CardMove) {
  const names = await columnNames(move.projectId, [move.from, move.to]);
  const from = names.get(move.from) ?? move.from;
  const to = names.get(move.to) ?? move.to;
  const lines = [
    `${await ownerMention(move.actor.userId)}«${from}» → «${to}»${move.note ? `: ${move.note}` : ""}`,
  ];
  if (move.link) lines.push(move.link);
  await createComment(
    move.taskId,
    move.actor.userId,
    lines.join("\n\n"),
    undefined,
    authorOfActor(move.actor),
  );
}

// A settings read that fails keeps the default (on): the status change is
// already saved and must not fail on a lookup.
async function autofillOn(projectId: string) {
  try {
    const workspaceId = await getProjectWorkspaceId(projectId);
    return await pipelineEnabled(workspaceId, "cardAutofill");
  } catch (error) {
    console.error("Card fill (settings) failed:", error);
    return true;
  }
}

function logged(step: string, work: Promise<unknown>) {
  return work.catch((error: unknown) => {
    console.error(`Card fill (${step}) failed:`, error);
  });
}

// After an agent's status change went through (owner, 30.10): the move, its
// note and link go to the comments at once, and the card gets the fields the
// stage implies. The change itself is already saved, so a failed step is
// logged rather than undoing it.
export async function fillCard(move: CardMove) {
  if (move.link) {
    await logged("link", addLink(move.taskId, move.link, move.actor.userId));
  }
  // Filling the assignee and start date is automation a product can switch off
  // (pipeline settings, `cardAutofill`); the move's comment always goes out.
  if (cardStage(move.to) && (await autofillOn(move.projectId))) {
    await logged("assignee", takeCard(move.taskId, move.actor.userId));
  }
  await logged("comment", commentMove(move));
}
