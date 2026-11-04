import {
  type ChatMessage,
  chatCompletion,
  LlmError,
} from "../llm/chat-completion";

// R-053: a rate-limited call waits for the window instead of moving to
// another provider; past this the reader gets the sources without waiting.
export const RATE_LIMIT_WAIT_MAX_MS = 20_000;

export type ModelReply =
  | { ok: true; content: string }
  | { ok: false; limited: boolean };

// One model call for the notebook (answers and briefs): a short rate limit is
// waited out once, any other failure comes back as a value, never a throw.
export async function callModel(
  config: { baseUrl: string; model: string; thinking?: string },
  key: string,
  messages: ChatMessage[],
  options: { maxTokens?: number } = {},
): Promise<ModelReply> {
  for (let attempt = 0; ; attempt++) {
    try {
      const content = await chatCompletion(config, key, messages, options);
      return { ok: true, content };
    } catch (error) {
      const limited =
        error instanceof LlmError && error.reason === "rate-limited";
      const wait = limited ? error.retryAfterMs : undefined;
      if (
        attempt === 0 &&
        wait !== undefined &&
        wait <= RATE_LIMIT_WAIT_MAX_MS
      ) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      return { ok: false, limited };
    }
  }
}
