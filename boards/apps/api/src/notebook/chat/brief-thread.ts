import db from "../../database";
import { notebookMessageTable } from "../../database/notebook-schema";
import { ApiError } from "../../errors/api-error";
import { effectiveNotebookModel } from "../../notebook-model/effective-notebook-model";
import { findThread, threadTurns, touchThread } from "./ask-notebook";
import { BRIEF_MAX_TOKENS, briefPrompt, parseBrief } from "./brief-prompt";
import { releaseCall, reserveCall } from "./call-budget";
import { callModel } from "./call-model";

// TB-3: a GOAL/CONSTRAINTS/ACCEPTANCE brief of the thread, stored in it. Like
// an answer, the call holds a place under the daily cap and its row carries
// the model, so a brief counts whether or not the model kept the format: a
// thread written to break the format cannot buy calls past the cap.
export async function briefThread(input: {
  workspaceId: string;
  threadId: string;
  userId: string | null;
}) {
  const thread = await findThread(input.workspaceId, input.threadId);
  const settings = await effectiveNotebookModel();
  const { key, model } = settings;
  if (!model || !key) {
    throw new ApiError(409, {
      code: "NOTEBOOK_MODEL_NOT_CONFIGURED",
      message: "No model is connected, so the notebook cannot write a brief.",
    });
  }
  const messages = briefPrompt(await threadTurns(thread.id));
  // Nothing between the place and the stored row throws, so it is released.
  if (!(await reserveCall(settings.dailyMax))) {
    throw new ApiError(429, {
      code: "NOTEBOOK_DAILY_LIMIT",
      message:
        "Today's model call limit is reached; briefs resume tomorrow (UTC).",
    });
  }
  const config = {
    baseUrl: settings.baseUrl,
    model,
    ...(settings.thinking ? { thinking: settings.thinking } : {}),
  };
  const reply = await callModel(config, key, messages, {
    maxTokens: BRIEF_MAX_TOKENS,
  });
  const brief = reply.ok ? parseBrief(reply.content) : null;
  const [row] = await db
    .insert(notebookMessageTable)
    .values({
      threadId: thread.id,
      workspaceId: input.workspaceId,
      role: "assistant",
      status: brief ? "brief" : "brief-failed",
      content: brief ?? "",
      model,
      createdBy: input.userId,
    })
    .returning()
    .finally(() => releaseCall());
  const touched = await touchThread(thread.id);
  if (!row) throw new Error("notebook brief insert failed");
  return { thread: touched ?? thread, messages: [row] };
}
