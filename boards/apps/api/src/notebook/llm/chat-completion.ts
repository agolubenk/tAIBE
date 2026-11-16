import type { NotebookUsage } from "../../database/notebook-schema";
import { withoutOutboundTelemetry } from "../../utils/sensitive-outbound";

const RESPONSE_MAX_BYTES = 512 * 1024;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type Failure = "timeout" | "http" | "network" | "response" | "rate-limited";

// Like OutboundRequestError: never carries the key, the URL or the body.
export class LlmError extends Error {
  constructor(
    readonly reason: Failure,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`LLM call failed: ${reason}${status ? ` (HTTP ${status})` : ""}`);
  }
}

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  // A number is never a date: Date.parse("-3") is the year -3.
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new LlmError("response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_MAX_BYTES) throw new LlmError("response");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LlmError("response");
  }
}

export function answerText(body: unknown): string {
  const content = (
    body as { choices?: { message?: { content?: unknown } }[] } | null
  )?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new LlmError("response");
  }
  return content.trim();
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// D-018: the provider's own token counts. OpenAI and OpenRouter put the cache
// in prompt_tokens_details.cached_tokens, DeepSeek in prompt_cache_hit_tokens;
// both count it inside prompt_tokens. A missing or odd usage is null, never a
// guess: the answer itself is not lost over it.
export function providerUsage(body: unknown): NotebookUsage | null {
  const usage = (body as { usage?: unknown } | null)?.usage as
    | {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown } | null;
        prompt_cache_hit_tokens?: unknown;
      }
    | null
    | undefined;
  if (!usage || typeof usage !== "object") return null;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (!isCount(input) || !isCount(output)) return null;
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    0;
  if (!isCount(cached) || cached > input) return null;
  return { input, output, cached };
}

export type ChatCompletion = { text: string; usage: NotebookUsage | null };

export async function chatCompletion(
  config: { baseUrl: string; model: string; thinking?: string },
  key: string,
  messages: ChatMessage[],
  options: { timeoutMs?: number; maxTokens?: number } = {},
): Promise<ChatCompletion> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  try {
    const response = await withoutOutboundTelemetry(() =>
      fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-title": "t-boards notebook",
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: options.maxTokens ?? 1200,
          temperature: 0.2,
          ...(config.thinking ? { thinking: { type: config.thinking } } : {}),
        }),
      }),
    );
    if (response.status === 429) {
      void response.body?.cancel().catch(() => {});
      throw new LlmError(
        "rate-limited",
        429,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new LlmError("http", response.status);
    }
    const body = await readBoundedJson(response);
    return { text: answerText(body), usage: providerUsage(body) };
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (signal.aborted) throw new LlmError("timeout");
    throw new LlmError("network");
  }
}
