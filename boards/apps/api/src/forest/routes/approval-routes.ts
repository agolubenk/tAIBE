import type { Context } from "hono";
import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
  z,
} from "../../openapi";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { resolveForestActor } from "../actor";
import {
  type FellAction,
  isGrantApprovalAction,
  isTaskApprovalAction,
} from "../approval/approval-params";
import { decideApproval } from "../approval/decide-approval";
import { batchCloseTarget } from "../approval/batch-close-target";
import { closingDoneRef } from "../approval/done-ref";
import { fellTargets } from "../approval/fell-targets";
import { grantApprovalTarget } from "../approval/grant-target";
import { requestApproval } from "../approval/request-approval";
import { taskApprovalTarget } from "../approval/task-approval-target";
import { loadApprovalTargets } from "../read/approval-targets";
import { listApprovals } from "../read/list-approvals";
import {
  approvalParam,
  approvalQuery,
  approvalListItemSchema,
  approvalSchema,
  decideApprovalBody,
  requestApprovalBody,
  workspaceParam,
} from "./schema";

const requestApprovalRoute = createRoute({
  method: "post",
  operationId: "requestForestApproval",
  path: "/{workspaceId}/approvals",
  tags: ["Forest"],
  summary: "Ask the owner for a «да»",
  description:
    "Records a pending approval for felling a tree or a sector, for an agent to close, reopen or reprioritise a card (R-022), to close a list of cards at once (close_task with taskIds, targetId the workspace id, up to 250 cards, each to its project's final column — TB-108), or for a one-time grant: create_label, attach_label, set_assignee (TB-102 R-10). The server fixes what it covers and applies it itself on the owner's «да» — in t-boards or in the owner queue; the agent does not repeat the write. close_task needs doneRef or doneReason (R-9). Felling needs task:delete.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: requestApprovalBody } },
    },
  },
  responses: {
    200: jsonResponse("The pending approval", approvalSchema),
    400: errorResponse(
      "A task action without a valid value, a grant without its parts, or close_task without doneRef/doneReason",
    ),
    403: errorResponse("Missing permission or project access"),
    404: errorResponse("Task, tree or sector not found"),
    410: errorResponse("The tree or sector was already felled"),
  },
});

const listApprovalsRoute = createRoute({
  method: "get",
  operationId: "listForestApprovals",
  path: "/{workspaceId}/approvals",
  tags: ["Forest"],
  summary: "List approvals",
  description:
    "Newest first; pending lists only approvals that have not expired.",
  middleware: [workspaceAccess.fromParam()] as const,
  request: { params: workspaceParam, query: approvalQuery },
  responses: {
    200: jsonResponse(
      "A page of approvals",
      z.object({
        items: z.array(approvalListItemSchema),
        nextCursor: z.string().nullable(),
      }),
    ),
    400: errorResponse("Invalid cursor"),
  },
});

const decideApprovalRoute = createRoute({
  method: "post",
  operationId: "decideForestApproval",
  path: "/{workspaceId}/approvals/{approvalId}/decide",
  tags: ["Forest"],
  summary: "Answer an approval",
  description:
    "Only the owner's own browser session can answer (N-011). Any token-bearing caller is refused and the attempt is journaled.",
  middleware: [workspaceAccess.fromParam()] as const,
  request: {
    params: approvalParam,
    body: {
      required: true,
      content: { "application/json": { schema: decideApprovalBody } },
    },
  },
  responses: {
    200: jsonResponse(
      "The answered approval: consumed (applied), rejected, or failed with failReason",
      approvalSchema,
    ),
    403: errorResponse("Not the owner's session"),
    409: errorResponse("Approval is not pending"),
  },
});

// Felling destroys the working tree, so its approval keeps task:delete.
async function fellApprovalTarget(
  c: Context,
  workspaceId: string,
  userId: string,
  action: FellAction,
  targetId: string,
) {
  await requireWorkspacePermission({ task: ["delete"] })(c, async () => {});
  const { targetType, treeIds } = await fellTargets(
    workspaceId,
    userId,
    action,
    targetId,
  );
  return { targetType, items: treeIds, params: undefined };
}

function toPublicApproval<
  T extends {
    paramsHash: string;
    decidedByUserId: string | null;
    queueItemId: string | null;
    queueItemVersion: number | null;
    queueSyncedStatus: string | null;
  },
>(approval: T) {
  // The queue item id stays server-side: an agent that knew it could edit
  // the item (security r2); queue_* fields are sync state, not API.
  const {
    paramsHash: _hash,
    decidedByUserId: _decider,
    queueItemId: _item,
    queueItemVersion: _version,
    queueSyncedStatus: _synced,
    ...rest
  } = approval;
  return rest;
}

export const approvalRoutes = apiRouter<
  BaseVariables & { workspaceId: string }
>()
  .openapi(requestApprovalRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const userId = c.get("userId");
    const done = closingDoneRef(body.action, body.doneRef, body.doneReason);
    const target =
      body.action === "close_task" && body.taskIds
        ? await batchCloseTarget(workspaceId, userId, body)
        : isTaskApprovalAction(body.action)
          ? {
              targetType: "task" as const,
              ...(await taskApprovalTarget(
                workspaceId,
                userId,
                body.action,
                body.targetId,
                body.value,
              )),
            }
          : isGrantApprovalAction(body.action)
            ? await grantApprovalTarget(workspaceId, userId, body.action, body)
            : await fellApprovalTarget(
                c,
                workspaceId,
                userId,
                body.action,
                body.targetId,
              );
    const approval = await requestApproval({
      ...done,
      workspaceId,
      action: body.action,
      targetType: target.targetType,
      targetId: body.targetId,
      items: target.items,
      params: target.params,
      reason: body.reason,
      actor: resolveForestActor(c),
    });
    return c.json(toPublicApproval(approval), 200);
  })
  .openapi(listApprovalsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const query = c.req.valid("query");
    const page = await listApprovals({ workspaceId, ...query });
    const targetOf = await loadApprovalTargets(
      page.items,
      workspaceId,
      c.get("userId"),
    );
    const items = page.items.map((approval) => ({
      ...toPublicApproval(approval),
      target: targetOf(approval),
    }));
    return c.json({ ...page, items }, 200);
  })
  .openapi(decideApprovalRoute, async (c) => {
    const { workspaceId, approvalId } = c.req.valid("param");
    const { decision } = c.req.valid("json");
    const approval = await decideApproval({
      approvalId,
      workspaceId,
      decision,
      actor: resolveForestActor(c),
    });
    return c.json(toPublicApproval(approval), 200);
  });
