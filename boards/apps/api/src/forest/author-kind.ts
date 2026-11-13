import { and, asc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import db from "../database";
import { activityTable, userTable } from "../database/schema";
import type { BaseVariables } from "../openapi";
import { type ForestActor, resolveForestActor } from "./actor";
import { isAgentAuthored } from "./agent-guard/agent-authored";

// TB-83: who wrote a task or a comment, as the answers show it. "human" — a
// person's own browser session, and only that. "agent" — everything else: an
// agent account (R-010), any write that holds a token (API key, MCP, bearer
// session, forest/actor.ts), text that came from outside (webhooks, imports)
// and text nobody recorded a writer for. Unknown fails closed to "agent".
// The kind is recorded at write time in the activity row (eventData.author);
// older rows without the mark fall back to the account's role.
export type AuthorKind = "agent" | "human";

export const AUTHOR_KINDS = ["agent", "human"] as const;

export function authorOfActor(actor: Pick<ForestActor, "kind">): AuthorKind {
  return actor.kind === "agent" ? "agent" : "human";
}

export function writerKind<E extends { Variables: BaseVariables }>(
  c: Context<E, any, any>,
): AuthorKind {
  return authorOfActor(resolveForestActor(c));
}

export function authorOfRow(
  role: string | null | undefined,
  eventData: unknown,
  externalSource?: string | null,
): AuthorKind {
  // Synced or imported text was written outside the board (GitHub, Jira…).
  if (role === "agent" || externalSource) return "agent";
  const marked =
    typeof eventData === "object" &&
    eventData !== null &&
    (eventData as { author?: unknown }).author === "agent";
  return marked ? "agent" : "human";
}

// The eventData of an activity row written by `author`.
export function authorMark(author: AuthorKind | undefined) {
  return author ? { author } : {};
}

// An edit by an agent makes the text the agent's; an edit by a person keeps
// the mark it had, so agent text never turns human by a later touch (SE-84).
export function markEdit(eventData: unknown, editor: AuthorKind | undefined) {
  if (editor !== "agent") return undefined;
  const kept =
    typeof eventData === "object" && eventData !== null ? eventData : {};
  return { ...kept, author: "agent" as const };
}

// A task's author is whoever created it: the first "created" (or imported
// "create") row of its activity, or the agent guard's journal of agent creates
// (N-004), which also covers tasks created before TB-83. A task with neither
// (a webhook-opened issue, a seeded card) counts as agent: fail closed.
export async function taskAuthor(taskId: string): Promise<AuthorKind> {
  const [created, journaled] = await Promise.all([
    createdRowAuthor(taskId),
    isAgentAuthored(taskId),
  ]);
  return journaled ? "agent" : created;
}

async function createdRowAuthor(taskId: string): Promise<AuthorKind> {
  const [row] = await db
    .select({ role: userTable.role, eventData: activityTable.eventData })
    .from(activityTable)
    .leftJoin(userTable, eq(activityTable.userId, userTable.id))
    .where(
      and(
        eq(activityTable.taskId, taskId),
        inArray(activityTable.type, ["created", "create"]),
      ),
    )
    .orderBy(asc(activityTable.createdAt))
    .limit(1);
  return row ? authorOfRow(row.role, row.eventData) : "agent";
}
