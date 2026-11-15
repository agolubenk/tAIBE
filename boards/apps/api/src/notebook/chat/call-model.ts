import type {
  ModelChain,
  ModelPoint,
} from "../../notebook-model/effective-notebook-model";
import { urlOrigin } from "../llm/base-url";
import {
  type ChatMessage,
  chatCompletion,
  LlmError,
} from "../llm/chat-completion";

// R-053: a short rate limit is waited out once on the same point; a longer one
// moves the call to the next point (TB-159).
export const RATE_LIMIT_WAIT_MAX_MS = 20_000;
// The whole chain fits in this, so a question never waits for every point's
// full timeout. The first point alone always fits, as before the chain.
export const CHAIN_DEADLINE_MS = 120_000;
const CALL_TIMEOUT_MS = 60_000;

export type ModelReply =
  | { ok: true; content: string; model: string }
  | { ok: false; limited: boolean; model: string };

type PointResult =
  | { ok: true; content: string; model: string }
  | { ok: false; limited: boolean; reason: string };

// Failed calls per point since the API started; the notebook runs on one API
// instance, so the count lives in memory and starts at zero after a restart.
const fails = new Map<string, number>();

export function failsSinceStart(pointId: string): number {
  return fails.get(pointId) ?? 0;
}

export function resetModelFails() {
  fails.clear();
}

function failureOf(error: unknown) {
  if (!(error instanceof LlmError)) {
    return { limited: false, reason: "error", waitMs: undefined };
  }
  return {
    limited: error.reason === "rate-limited",
    reason: error.status ? `${error.reason} ${error.status}` : error.reason,
    waitMs: error.retryAfterMs,
  };
}

async function callPoint(
  point: ModelPoint,
  messages: ChatMessage[],
  options: { maxTokens?: number },
  deadline: number,
): Promise<PointResult> {
  const config = {
    baseUrl: point.baseUrl,
    model: point.model,
    models: point.models,
    ...(point.thinking ? { thinking: point.thinking } : {}),
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const timeoutMs = Math.min(CALL_TIMEOUT_MS, deadline - Date.now());
      const answer = await chatCompletion(config, point.key, messages, {
        ...options,
        timeoutMs,
      });
      return { ok: true, ...answer };
    } catch (error) {
      const { limited, reason, waitMs } = failureOf(error);
      if (
        attempt === 0 &&
        limited &&
        waitMs !== undefined &&
        waitMs <= RATE_LIMIT_WAIT_MAX_MS &&
        Date.now() + waitMs < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      return { ok: false, limited, reason };
    }
  }
}

// The address's origin and the model only: never the key or the URL path.
function logFailure(
  points: ModelChain,
  index: number,
  reason: string,
  moving: boolean,
) {
  const point = points[index] as ModelPoint;
  const next = moving ? `moving to point ${index + 2}` : "no point left";
  console.warn(
    `Notebook model point ${index + 1}/${points.length} (${urlOrigin(point.baseUrl)}, ${point.model}) failed: ${reason}; ${next}`,
  );
}

// One model call for the notebook (answers and briefs): the points are tried
// in the admin's order, and any failure of a point moves to the next one. The
// result comes back as a value, never a throw.
export async function callModel(
  points: ModelChain,
  messages: ChatMessage[],
  options: { maxTokens?: number } = {},
): Promise<ModelReply> {
  const deadline = Date.now() + CHAIN_DEADLINE_MS;
  let limited = true;
  let tried: ModelPoint = points[0];
  for (const [index, point] of points.entries()) {
    tried = point;
    const reply = await callPoint(point, messages, options, deadline);
    if (reply.ok) return reply;
    fails.set(point.id, failsSinceStart(point.id) + 1);
    limited &&= reply.limited;
    const moving = index + 1 < points.length && Date.now() < deadline;
    logFailure(points, index, reply.reason, moving);
    if (!moving) break;
  }
  return { ok: false, limited, model: tried.model };
}
