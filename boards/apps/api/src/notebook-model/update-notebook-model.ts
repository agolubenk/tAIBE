import { HTTPException } from "hono/http-exception";
import db from "../database";
import { normalizeBaseUrl, urlOrigin } from "../notebook/llm/base-url";
import { notebookLlmConfig } from "../notebook/llm/llm-config";
import {
  lockStoredNotebookModel,
  readStoredNotebookModel,
  type StoredNotebookModel,
  writeStoredNotebookModel,
} from "./notebook-model-store";
import type { UpdateNotebookModel } from "./schema";
import { canSealSecrets, sealSecret } from "./secret-box";
import { applyChain, sendsChainKey } from "./update-model-chain";

function applyFields(current: StoredNotebookModel, patch: UpdateNotebookModel) {
  const next: StoredNotebookModel = { ...current };
  for (const field of [
    "baseUrl",
    "model",
    "models",
    "embedModel",
    "dailyMax",
  ] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null || (Array.isArray(value) && !value.length)) {
      delete next[field];
    } else (next as Record<string, unknown>)[field] = value;
  }
  if (next.baseUrl) next.baseUrl = normalizeBaseUrl(next.baseUrl);
  return next;
}

// A field left out keeps its value; null clears it back to the server's
// default. Each key is sealed to the API address it is meant for before it
// reaches the database.
export async function updateNotebookModel(
  patch: UpdateNotebookModel,
  actorId: string,
) {
  if (
    (typeof patch.key === "string" || sendsChainKey(patch)) &&
    !canSealSecrets()
  ) {
    throw new HTTPException(409, {
      message:
        "The server has no settings encryption key, so a model key cannot be stored",
    });
  }
  const envBaseUrl = notebookLlmConfig().baseUrl;
  await db.transaction(async (tx) => {
    await lockStoredNotebookModel(tx);
    const current = await readStoredNotebookModel(tx);
    const next = applyFields(current, patch);
    const origin = urlOrigin(next.baseUrl ?? envBaseUrl);
    if (patch.key === null) delete next.key;
    else if (patch.key !== undefined) next.key = sealSecret(patch.key, origin);
    else if (next.key && origin !== urlOrigin(current.baseUrl ?? envBaseUrl)) {
      throw new HTTPException(409, {
        message:
          "The stored key belongs to the previous API address: enter the key again or remove it",
      });
    }
    const chain = applyChain(current.chain, patch.chain);
    if (chain) next.chain = chain;
    else delete next.chain;
    await writeStoredNotebookModel(next, actorId, tx);
  });
}
