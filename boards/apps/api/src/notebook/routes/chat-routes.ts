import { HTTPException } from "hono/http-exception";
import type {
  NotebookCitation,
  NotebookMessageStatus,
} from "../../database/notebook-schema";
import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { boundedRequestBody } from "../../utils/bounded-request-body";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { askNotebook } from "../chat/ask-notebook";
import { briefThread } from "../chat/brief-thread";
import { deleteThread, listThreads, readThread } from "../chat/read-threads";
import {
  askBody,
  CHAT_BODY_BYTES,
  threadParam,
  threadsSchema,
  threadWithMessagesSchema,
  workspaceParam,
} from "./schema";

type Thread = { id: string; title: string; createdAt: Date; updatedAt: Date };
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: NotebookMessageStatus | null;
  citations: NotebookCitation[];
  model: string | null;
  createdAt: Date;
};

const toThread = ({ id, title, createdAt, updatedAt }: Thread) => ({
  id,
  title,
  createdAt,
  updatedAt,
});

// Explicit fields: the rows also carry author ids the client has no use for.
const toMessage = (message: Message) => {
  const { id, role, content, status, citations, model, createdAt } = message;
  return { id, role, content, status, citations, model, createdAt };
};

const toThreadResponse = (body: { thread: Thread; messages: Message[] }) => ({
  thread: toThread(body.thread),
  messages: body.messages.map(toMessage),
});

const listThreadsRoute = createRoute({
  method: "get",
  operationId: "listNotebookThreads",
  path: "/{workspaceId}/threads",
  tags: ["Notebook"],
  summary: "List notebook threads",
  description: "The workspace's notebook conversations, newest first.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Notebook threads", threadsSchema),
    403: errorResponse("Missing workspace:read permission"),
  },
});

const startThreadRoute = createRoute({
  method: "post",
  operationId: "startNotebookThread",
  path: "/{workspaceId}/threads",
  tags: ["Notebook"],
  summary: "Ask the notebook a new question",
  description:
    "Starts a thread: finds the sources and, when a model is configured and within its daily budget, writes an answer citing them as [n].",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
    boundedRequestBody(CHAT_BODY_BYTES),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: askBody } },
    },
  },
  responses: {
    201: jsonResponse(
      "The thread with the question and the answer",
      threadWithMessagesSchema,
    ),
    403: errorResponse("Missing workspace:read permission"),
  },
});

const readThreadRoute = createRoute({
  method: "get",
  operationId: "getNotebookThread",
  path: "/{workspaceId}/threads/{threadId}",
  tags: ["Notebook"],
  summary: "Read a notebook thread",
  description: "The thread's questions and answers in order.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: threadParam },
  responses: {
    200: jsonResponse("Notebook thread", threadWithMessagesSchema),
    403: errorResponse("Missing workspace:read permission"),
    404: errorResponse("Notebook thread not found"),
  },
});

const askInThreadRoute = createRoute({
  method: "post",
  operationId: "askNotebookThread",
  path: "/{workspaceId}/threads/{threadId}/messages",
  tags: ["Notebook"],
  summary: "Ask a follow-up question",
  description:
    "Adds a question to the thread; earlier turns stay in the model's context, the sources come from the new question.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
    boundedRequestBody(CHAT_BODY_BYTES),
  ] as const,
  request: {
    params: threadParam,
    body: {
      required: true,
      content: { "application/json": { schema: askBody } },
    },
  },
  responses: {
    200: jsonResponse(
      "The new question and its answer",
      threadWithMessagesSchema,
    ),
    403: errorResponse("Missing workspace:read permission"),
    404: errorResponse("Notebook thread not found"),
  },
});

const briefThreadRoute = createRoute({
  method: "post",
  operationId: "briefNotebookThread",
  path: "/{workspaceId}/threads/{threadId}/brief",
  tags: ["Notebook"],
  summary: "Brief a notebook thread",
  description:
    "Asks the model for a GOAL / CONSTRAINTS / ACCEPTANCE brief of the thread's questions and answers and stores it in the thread as status brief, or brief-failed when the model returned none. The call counts under the daily budget.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: threadParam },
  responses: {
    200: jsonResponse("The stored brief", threadWithMessagesSchema),
    403: errorResponse("Missing workspace:read permission"),
    404: errorResponse("Notebook thread not found"),
    409: errorResponse("No model is connected (NOTEBOOK_MODEL_NOT_CONFIGURED)"),
    429: errorResponse(
      "Today's model call limit is reached (NOTEBOOK_DAILY_LIMIT)",
    ),
  },
});

const deleteThreadRoute = createRoute({
  method: "delete",
  operationId: "deleteNotebookThread",
  path: "/{workspaceId}/threads/{threadId}",
  tags: ["Notebook"],
  summary: "Delete a notebook thread",
  description: "Removes the thread with all its questions and answers.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: { params: threadParam },
  responses: {
    204: { description: "Thread deleted" },
    403: errorResponse("Missing workspace:manage_settings permission"),
    404: errorResponse("Notebook thread not found"),
  },
});

export const chatRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(listThreadsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const threads = await listThreads(workspaceId);
    return c.json({ threads: threads.map(toThread) }, 200);
  })
  .openapi(startThreadRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { question } = c.req.valid("json");
    const asked = await askNotebook({
      workspaceId,
      question,
      userId: c.get("userId") ?? null,
    });
    return c.json(toThreadResponse(asked), 201);
  })
  .openapi(readThreadRoute, async (c) => {
    const { workspaceId, threadId } = c.req.valid("param");
    return c.json(
      toThreadResponse(await readThread(workspaceId, threadId)),
      200,
    );
  })
  .openapi(askInThreadRoute, async (c) => {
    const { workspaceId, threadId } = c.req.valid("param");
    const { question } = c.req.valid("json");
    const asked = await askNotebook({
      workspaceId,
      threadId,
      question,
      userId: c.get("userId") ?? null,
    });
    return c.json(toThreadResponse(asked), 200);
  })
  .openapi(briefThreadRoute, async (c) => {
    const { workspaceId, threadId } = c.req.valid("param");
    const briefed = await briefThread({
      workspaceId,
      threadId,
      userId: c.get("userId") ?? null,
    });
    return c.json(toThreadResponse(briefed), 200);
  })
  .openapi(deleteThreadRoute, async (c) => {
    const { workspaceId, threadId } = c.req.valid("param");
    if (!(await deleteThread(workspaceId, threadId))) {
      throw new HTTPException(404, { message: "Notebook thread not found" });
    }
    return c.body(null, 204);
  });
