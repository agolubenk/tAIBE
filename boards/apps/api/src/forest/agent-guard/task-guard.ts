import type { Context, Next } from "hono";
import { assertProjectAccess } from "../../project-access/assert-project-access";
import { type ForestActor, resolveForestActor } from "../actor";
import { assertReviewLink } from "../card-fill/assert-review-link";
import { readCardFillHeaders } from "../card-fill/card-fill-headers";
import { cardStage } from "../card-fill/card-stage";
import { fillCard } from "../card-fill/fill-card";
import { ForestError } from "../forest-error";
import { attributeAgentEdit } from "../history/attribute-agent-edit";
import { writeJournal } from "../journal";
import { AGENT_CREATE_ACTION, isAgentAuthored } from "./agent-authored";
import { readAgentHeaders } from "./agent-headers";
import { assertAgentLease } from "./assert-agent-lease";
import {
  classifyTaskRequest,
  readsBody,
  type TaskRequest,
} from "./classify-task-request";
import { isClosingStatus } from "./closing-status";
import {
  changesText,
  decideTaskWrite,
  type WriteFacts,
} from "./decide-task-write";
import { answeredApproval } from "./answered-approval";
import { isPlainJson } from "./json-media-type";
import { loadGuardedTask, projectWorkspace } from "./load-task";
import { type MoveFacts, moveFacts, moveRoute } from "./move-facts";

type Denial = {
  workspaceId: string | null;
  actor: ForestActor;
  action: string;
  targetId: string;
};

// The refusal is journaled before it is thrown, outside any transaction, so
// it survives (AC-007, AC-008, AC-027).
async function deny(at: Denial, error: ForestError): Promise<never> {
  await writeJournal({
    ...at,
    targetType: "task",
    outcome: "denied",
    detail: error.message,
  });
  throw error;
}

// null: the body is not a plain JSON object, so the guard cannot tell what
// the write changes and refuses it.
async function readBody(c: Context, segments: string[]) {
  if (!readsBody(c.req.method, segments)) return {};
  if (!isPlainJson(c.req.header("content-type"))) return null;
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function taskSegments(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(parts.indexOf("task") + 1);
}

async function guardCreate(
  c: Context,
  next: Next,
  actor: ForestActor,
  request: Extract<TaskRequest, { kind: "create" }>,
) {
  const workspaceId = await projectWorkspace(request.projectId);
  if (!workspaceId) return next();
  if (
    request.status &&
    (await isClosingStatus(request.projectId, request.status))
  ) {
    await deny(
      {
        workspaceId,
        actor,
        action: AGENT_CREATE_ACTION,
        targetId: request.projectId,
      },
      new ForestError(
        "approval_required",
        "create the card in an open status; closing needs the owner's «да»",
      ),
    );
  }
  await next();
  if (!c.res.ok) return;
  const created: unknown = await c.res
    .clone()
    .json()
    .catch(() => null);
  const id = (created as { id?: unknown } | null)?.id;
  if (typeof id !== "string") return;
  await writeJournal({
    workspaceId,
    actor,
    action: AGENT_CREATE_ACTION,
    targetType: "task",
    targetId: id,
    outcome: "allowed",
  });
}

type GuardedTask = NonNullable<Awaited<ReturnType<typeof loadGuardedTask>>>;

// What an edit does to the card's closed state. A move to another project
// compares the two projects by the column the card lands in (TB-80).
async function writeFacts(
  request: Extract<TaskRequest, { kind: "edit" }>,
  task: GuardedTask,
): Promise<{
  moved: MoveFacts | null;
  statusChanged: boolean;
  facts: WriteFacts;
}> {
  const { changes } = request;
  const destination =
    request.action === "task.move" && changes.projectId !== task.projectId
      ? changes.projectId
      : undefined;
  // null for a move move-task refuses itself: nothing to judge (moveFacts).
  const moved = destination
    ? await moveFacts(task, destination, changes.status)
    : null;
  const statusChanged =
    changes.status !== undefined && changes.status !== task.status;
  const closes = destination
    ? (moved?.closes ?? false)
    : statusChanged && changes.status
      ? await isClosingStatus(
          changes.projectId ?? task.projectId,
          changes.status,
        )
      : false;
  const reopens = destination
    ? (moved?.reopens ?? false)
    : statusChanged && !closes
      ? await isClosingStatus(task.projectId, task.status)
      : false;
  const authoredByAgent = changesText(changes, task)
    ? await isAgentAuthored(task.id)
    : false;
  return {
    moved,
    statusChanged,
    facts: { closes, reopens, authoredByAgent, landing: moved?.landing },
  };
}

// Where to ask for the owner's «да». A move never spends one: the «да» sets
// a status in the card's current project and moves nothing (TB-80), so a
// move gets the way round instead (moveRoute).
function approvalRequired(
  approval: { action: string; value: string },
  task: { id: string; workspaceId: string },
  moved: MoveFacts | null,
) {
  const url = `/api/forest/${task.workspaceId}/approvals`;
  return new ForestError(
    "approval_required",
    moved
      ? `${moveRoute(moved, url)}. The owner's «да» sets a status in the card's current project and moves nothing, so a move never spends one`
      : `ask the owner: POST ${url} {action: "${approval.action}", targetId: "${task.id}", value: "${approval.value}"}; the server applies the owner's «да» itself`,
  );
}

async function guardEdit(
  c: Context,
  next: Next,
  actor: ForestActor,
  request: Extract<TaskRequest, { kind: "edit" }>,
) {
  const task = await loadGuardedTask(request.taskId);
  // Unknown and felled ids get the upstream 404 or the forest's «felled».
  if (!task) return next();
  await assertProjectAccess(actor.userId, task.projectId);

  const at = {
    workspaceId: task.workspaceId,
    actor,
    action: request.action,
    targetId: task.id,
  };
  const { changes } = request;
  const { moved, statusChanged, facts } = await writeFacts(request, task);
  const decision = decideTaskWrite(changes, task, facts);
  if (decision.kind === "deny") {
    await deny(at, new ForestError("agent_forbidden", decision.reason));
    return;
  }

  const headers = readAgentHeaders(c);
  const fill = readCardFillHeaders(c);
  const to = statusChanged ? changes.status : undefined;
  try {
    await assertAgentLease(actor, task.id, headers);
    if (to && cardStage(to) === "review") {
      await assertReviewLink(task.id, fill.link);
    }
  } catch (error) {
    if (error instanceof ForestError) await deny(at, error);
    throw error;
  }

  const { approval } = decision;
  const attribute = async () => {
    await attributeAgentEdit(task.id, task.revision, actor.id);
    if (!to) return;
    await fillCard({
      taskId: task.id,
      projectId: changes.projectId ?? task.projectId,
      from: task.status,
      to,
      actor,
      ...fill,
    });
  };
  if (!approval) {
    await next();
    if (c.res.ok) await attribute();
    return;
  }
  if (moved || !headers.approvalId) {
    await deny(at, approvalRequired(approval, task, moved));
    return;
  }
  const answered = await answeredApproval({
    approvalId: headers.approvalId,
    workspaceId: task.workspaceId,
    action: approval.action,
    taskId: task.id,
    value: approval.value,
  });
  if (answered.kind === "refused") {
    await deny(at, answered.error);
    return;
  }
  // R-5: already applied by the server — answer 200 and write nothing.
  const appliedAt = answered.appliedAt?.toISOString() ?? null;
  await writeJournal({
    ...at,
    action: `${request.action}:${approval.action}`,
    targetType: "task",
    outcome: "allowed",
    detail: `approval ${answered.approvalId} already applied by the server at ${appliedAt ?? "?"}; nothing written`,
  });
  return c.json(
    {
      alreadyApplied: true,
      approvalId: answered.approvalId,
      appliedAt,
      message: `уже применено сервером в ${appliedAt ?? "?"}`,
    },
    200,
  );
}

// R-022, N-004 and AC-010 for agents on the kaneo task routes. People in the
// UI pass untouched; the API's own permission checks still run after this.
export async function agentTaskGuard(c: Context, next: Next) {
  const actor = resolveForestActor(c);
  if (actor.kind !== "agent") return next();

  const segments = taskSegments(c.req.path);
  const body = await readBody(c, segments);
  const request = classifyTaskRequest(c.req.method, segments, body ?? {});
  if (!body && (request.kind === "create" || request.kind === "edit")) {
    await deny(
      request.kind === "create"
        ? {
            workspaceId: await projectWorkspace(request.projectId),
            actor,
            action: AGENT_CREATE_ACTION,
            targetId: request.projectId,
          }
        : {
            workspaceId:
              (await loadGuardedTask(request.taskId))?.workspaceId ?? null,
            actor,
            action: request.action,
            targetId: request.taskId,
          },
      new ForestError(
        "agent_forbidden",
        "send task writes as application/json with a JSON object body",
      ),
    );
  }
  if (request.kind === "pass") return next();
  if (request.kind === "create") return guardCreate(c, next, actor, request);
  if (request.kind === "edit") return guardEdit(c, next, actor, request);

  const task =
    request.action === "task.delete"
      ? await loadGuardedTask(request.targetId)
      : null;
  await deny(
    {
      workspaceId: task?.workspaceId ?? null,
      actor,
      action: request.action,
      targetId: request.targetId,
    },
    new ForestError("agent_forbidden", request.reason),
  );
}
