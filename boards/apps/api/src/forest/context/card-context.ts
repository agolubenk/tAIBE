import { HTTPException } from "hono/http-exception";
import getTaskRelations from "../../task-relation/controllers/get-task-relations";
import { loadCardMeta, toCardMeta } from "../card/card-meta";
import {
  CONTEXT_LIMITS,
  type ContextSection,
  capSection,
  toContextRelations,
} from "./context-sections";
import { loadContextTask } from "./load-context-task";
import {
  loadContextComments,
  loadContextHistory,
} from "./load-context-threads";
import { loadContextApprovals, loadContextLease } from "./load-context-work";
import {
  redactContextApproval,
  redactContextComment,
  redactContextMeta,
  redactContextRelation,
  redactContextTask,
} from "./redact-context";

// One read to pick up a card (R-031): the task, its fields, who holds it,
// open «да» requests, links, the latest comments and edits. The route has
// already checked the card belongs to the workspace and the caller sees it;
// linked cards from projects the caller cannot see are left out.
export async function buildCardContext(
  taskId: string,
  workspaceId: string,
  userId: string,
) {
  const now = new Date();
  const [task, meta, lease, approvals, relations, comments, history] =
    await Promise.all([
      loadContextTask(taskId),
      loadCardMeta(taskId),
      loadContextLease(taskId, now),
      loadContextApprovals(
        workspaceId,
        taskId,
        now,
        CONTEXT_LIMITS.approvals + 1,
      ),
      getTaskRelations(taskId, workspaceId, userId),
      loadContextComments(taskId, CONTEXT_LIMITS.comments + 1),
      loadContextHistory(taskId, CONTEXT_LIMITS.history + 1),
    ]);
  if (!task) throw new HTTPException(404, { message: "Task not found" });

  const sections = {
    approvals: capSection(approvals, "approvals"),
    relations: capSection(toContextRelations(taskId, relations), "relations"),
    comments: capSection(comments, "comments"),
    history: capSection(history, "history"),
  };
  const truncated = (Object.keys(sections) as ContextSection[]).filter(
    (section) => sections[section].cut,
  );
  const { taskId: _, ...fields } = toCardMeta(taskId, meta);

  // Free text leaves through redact, after the caps (TB-141); edits carry
  // field names only, no values.
  return {
    ...redactContextTask(task),
    meta: redactContextMeta(fields),
    lease,
    approvals: sections.approvals.items.map(redactContextApproval),
    relations: sections.relations.items.map(redactContextRelation),
    comments: sections.comments.items.map(redactContextComment),
    history: sections.history.items,
    truncated,
  };
}
