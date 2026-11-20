import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { normalizeBaseUrl, urlOrigin } from "../notebook/llm/base-url";
import type { StoredModelPoint } from "./notebook-model-store";
import type { UpdateModelPoint, UpdateNotebookModel } from "./schema";
import { sealSecret } from "./secret-box";

// The key a point keeps: a new one is sealed to the point's address; a stored
// one stays only while the address keeps its origin.
function pointKey(
  sent: UpdateModelPoint["key"],
  stored: StoredModelPoint | undefined,
  origin: string,
  position: number,
): string | undefined {
  if (sent === null) return undefined;
  if (sent !== undefined) return sealSecret(sent, origin);
  if (!stored?.key) return undefined;
  if (urlOrigin(stored.baseUrl) !== origin) {
    throw new HTTPException(409, {
      message: `The stored key of chain point ${position} belongs to its previous API address: enter the key again or remove it`,
    });
  }
  return stored.key;
}

// TB-159: the chain is sent whole, in the order to try it. A point that names
// an id is the stored point with that id and keeps its key unless told
// otherwise; a point without an id is new.
export function applyChain(
  current: StoredModelPoint[] | undefined,
  patch: UpdateNotebookModel["chain"],
): StoredModelPoint[] | undefined {
  if (patch === undefined) return current;
  if (patch === null) return undefined;
  const stored = new Map((current ?? []).map((point) => [point.id, point]));
  const seen = new Set<string>();
  const chain = patch.map((point, index): StoredModelPoint => {
    const old = point.id === undefined ? undefined : stored.get(point.id);
    if (point.id !== undefined && (!old || seen.has(point.id))) {
      throw new HTTPException(400, {
        message: `Chain point ${index + 1} names an id that is not in the chain or is used twice`,
      });
    }
    const id = point.id ?? randomUUID();
    seen.add(id);
    const baseUrl = normalizeBaseUrl(point.baseUrl);
    const key = pointKey(point.key, old, urlOrigin(baseUrl), index + 1);
    return {
      id,
      baseUrl,
      model: point.model,
      ...(point.models?.length ? { models: point.models } : {}),
      ...(key ? { key } : {}),
    };
  });
  return chain.length ? chain : undefined;
}

export const sendsChainKey = (patch: UpdateNotebookModel) =>
  (patch.chain ?? []).some((point) => typeof point.key === "string");
