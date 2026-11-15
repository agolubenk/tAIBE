import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiError } from "../errors/api-error";
import { resolveForestActor } from "../forest/actor";
import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { isTokenCaller, maskForTokenCaller } from "../utils/token-caller-text";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import { withAttachLease } from "./attach-lease";
import attachForm from "./controllers/attach-form";
import createTemplate from "./controllers/create-template";
import exportForm from "./controllers/export-form";
import getTaskForms from "./controllers/get-task-forms";
import saveAnswers from "./controllers/save-answers";
import {
  answersRejectedSchema,
  formExportSchema,
  formTemplateRowSchema,
  saveAnswersResponseSchema,
  taskFormListSchema,
  taskFormSchema,
} from "./response";
import {
  ANSWERS_BODY_MAX,
  attachFormBody,
  createTemplateBody,
  saveAnswersBody,
  TEMPLATE_BODY_MAX,
  taskFormIdParam,
  taskIdParam,
  workspaceIdParam,
} from "./schema";

const TAG = ["Forms"];

/** The size check runs before the JSON is parsed: a large body costs no parse. */
function limit(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: () => {
      throw new ApiError(413, {
        message: `The body is larger than ${maxSize} bytes`,
        code: "PAYLOAD_TOO_LARGE",
      });
    },
  });
}

/** F-24-1: a person answers a form in the web app; an agent token only reads. */
const personOnly: MiddlewareHandler = async (c, next) => {
  if (isTokenCaller(c)) {
    throw new ApiError(403, {
      message: "Only a person answers a form, in the web app",
      code: "PERSON_ONLY",
    });
  }
  await next();
};

const createTemplateRoute = createRoute({
  method: "post",
  operationId: "createFormTemplate",
  path: "/template/{workspaceId}",
  tags: TAG,
  summary: "Create a form template",
  description:
    "Store a form template version in a workspace. A version does not change: send the next version for a change.",
  middleware: [
    limit(TEMPLATE_BODY_MAX),
    workspaceAccess.fromParam("workspaceId"),
    requireWorkspacePermission({ task: ["create"] }),
  ] as const,
  request: {
    params: workspaceIdParam,
    body: {
      content: { "application/json": { schema: createTemplateBody } },
    },
  },
  responses: {
    201: jsonResponse("The stored template version", formTemplateRowSchema),
    400: errorResponse("The template is not valid"),
    403: errorResponse("No access to the workspace, or no create permission"),
    409: errorResponse("This template version exists"),
    413: errorResponse("The body is too large"),
  },
});

const attachFormRoute = createRoute({
  method: "post",
  operationId: "attachTaskForm",
  path: "/task/{taskId}",
  tags: TAG,
  summary: "Attach a form to a task",
  description:
    "Attach a template of the task's workspace to the task. An agent attaches only under its lease on the task (AC-010): the lease token goes in x-t-boards-fence.",
  middleware: [
    workspaceAccess.fromTaskId("taskId"),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: {
    params: taskIdParam,
    body: { content: { "application/json": { schema: attachFormBody } } },
  },
  responses: {
    201: jsonResponse("The attached form", taskFormSchema),
    403: errorResponse("No access to the task, or no update permission"),
    404: errorResponse("Task or template not found"),
    409: errorResponse(
      "This template is already on the task, or an agent has no live lease on it",
    ),
  },
});

const getTaskFormsRoute = createRoute({
  method: "get",
  operationId: "getTaskForms",
  path: "/task/{taskId}",
  tags: TAG,
  summary: "Get the forms of a task",
  description:
    "Get every form on a task, with its template and answers. A token caller gets masked text.",
  middleware: [
    workspaceAccess.fromTaskId("taskId"),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: taskIdParam },
  responses: {
    200: jsonResponse("The forms of the task", taskFormListSchema),
    403: errorResponse("No access to the task, or no read permission"),
    404: errorResponse("Task not found"),
  },
});

const saveAnswersRoute = createRoute({
  method: "put",
  operationId: "saveTaskFormAnswers",
  path: "/{id}/answers",
  tags: TAG,
  summary: "Save form answers",
  description:
    "Save a draft (submit false) or submit the answers (submit true). rowVersion is the version the client read. Only a person in the web app answers: a token caller gets 403.",
  // The limit goes first: fromTaskForm reads the JSON body (a lookup source
  // also accepts the id from the body), which locks the stream for bodyLimit.
  middleware: [
    limit(ANSWERS_BODY_MAX),
    workspaceAccess.fromTaskForm("id"),
    requireWorkspacePermission({ task: ["update"] }),
    personOnly,
  ] as const,
  request: {
    params: taskFormIdParam,
    body: { content: { "application/json": { schema: saveAnswersBody } } },
  },
  responses: {
    200: jsonResponse("The saved state", saveAnswersResponseSchema),
    403: errorResponse("No access, no update permission, or a token caller"),
    404: errorResponse("Form not found"),
    409: errorResponse(
      "The form changed since the client read it (ROW_VERSION_CONFLICT), or the answers are for another template version (VERSION_MISMATCH)",
    ),
    413: errorResponse("The body is too large"),
    422: jsonResponse(
      "The answers do not fit the template",
      answersRejectedSchema,
    ),
  },
});

const exportFormRoute = createRoute({
  method: "get",
  operationId: "exportTaskForm",
  path: "/{id}/export",
  tags: TAG,
  summary: "Export form answers",
  description:
    "The answers as the grill's JSON export. A token caller gets masked text.",
  middleware: [
    workspaceAccess.fromTaskForm("id"),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: taskFormIdParam },
  responses: {
    200: jsonResponse("The export", formExportSchema),
    403: errorResponse("No access to the form, or no read permission"),
    404: errorResponse("Form not found"),
  },
});

const form = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(createTemplateRoute, async (c) => {
    const { template } = c.req.valid("json");
    const row = await createTemplate(
      c.req.valid("param").workspaceId,
      template,
      resolveForestActor(c).id,
    );
    return c.json(row, 201);
  })
  .openapi(attachFormRoute, async (c) => {
    const { taskId } = c.req.valid("param");
    const workspaceId = c.get("workspaceId");
    const { templateId } = c.req.valid("json");
    const actor = resolveForestActor(c);
    const attached = await withAttachLease(
      c,
      { actor, taskId, workspaceId },
      () => attachForm(taskId, workspaceId, templateId, actor.id),
    );
    return c.json(maskForTokenCaller(c, attached), 201);
  })
  .openapi(getTaskFormsRoute, async (c) =>
    c.json(
      maskForTokenCaller(c, await getTaskForms(c.req.valid("param").taskId)),
      200,
    ),
  )
  .openapi(saveAnswersRoute, async (c) => {
    const result = await saveAnswers(
      c.req.valid("param").id,
      c.req.valid("json"),
      c.get("userId"),
    );
    if ("issues" in result) {
      return c.json(
        {
          message: "The answers do not fit the template",
          code: "INVALID_ANSWERS",
          answerIssues: result.issues,
        },
        422,
      );
    }
    return c.json(result.saved, 200);
  })
  .openapi(exportFormRoute, async (c) =>
    c.json(
      maskForTokenCaller(c, await exportForm(c.req.valid("param").id)),
      200,
    ),
  );

export default form;
