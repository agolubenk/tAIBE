import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  answeredModel,
  answerText,
  chatCompletion,
  LlmError,
  parseRetryAfter,
} from "./chat-completion";

const CONFIG = {
  baseUrl: "http://llm.test/v1",
  model: "test-model",
  keyFile: "/unused",
  dailyMax: 10,
};
const KEY = "sk-secret-never-in-errors";
const ASK = [{ role: "user" as const, content: "Что такое аренда?" }];

const reply = (content: unknown, model?: string) =>
  new Response(
    JSON.stringify({
      ...(model ? { model } : {}),
      choices: [{ message: { content } }],
    }),
    { headers: { "content-type": "application/json" } },
  );

const sentBodies = (fetch: { mock: { calls: unknown[] } }) =>
  (fetch.mock.calls as [string, RequestInit][]).map(([, init]) =>
    JSON.parse(String(init.body)),
  );

async function failure(call: Promise<unknown>) {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LlmError);
  expect(String((error as Error).message)).not.toContain(KEY);
  return error as LlmError;
}

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    expect(parseRetryAfter("7", now)).toBe(7000);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("Wed, 28 Oct 2026 12:00:05 GMT", now)).toBe(5000);
  });

  it("never waits a negative time and ignores nonsense", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    expect(parseRetryAfter("Wed, 28 Oct 2026 11:59:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("-3", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe("answerText", () => {
  it("takes the first choice and trims it", () => {
    expect(
      answerText({ choices: [{ message: { content: "  Ответ [1]\n" } }] }),
    ).toBe("Ответ [1]");
  });

  it.each([
    null,
    {},
    { choices: [] },
    { choices: [{ message: { content: "   " } }] },
    { choices: [{ message: { content: 42 } }] },
  ])("treats %j as a broken response", (body) => {
    expect(() => answerText(body)).toThrow(LlmError);
  });
});

describe("answeredModel", () => {
  const config = {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "a/free:free",
    models: ["b/fallback:free", "c/other"],
  };

  it("names the listed model that answered", () => {
    expect(answeredModel({ model: "b/fallback:free" }, config)).toBe(
      "b/fallback:free",
    );
    expect(answeredModel({ model: "c/other" }, config)).toBe("c/other");
  });

  it("matches a name sent without its :variant suffix", () => {
    expect(answeredModel({ model: "b/fallback" }, config)).toBe(
      "b/fallback:free",
    );
  });

  it("keeps the point's model for any other name or none", () => {
    expect(answeredModel({ model: "x/unlisted" }, config)).toBe("a/free:free");
    expect(answeredModel({ model: 7 }, config)).toBe("a/free:free");
    expect(answeredModel(null, config)).toBe("a/free:free");
  });
});

describe("chatCompletion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the model and the messages with the key as a bearer token", async () => {
    const fetch = vi.fn(async () => reply("Ответ [1]"));
    vi.stubGlobal("fetch", fetch);

    expect(await chatCompletion(CONFIG, KEY, ASK)).toEqual({
      content: "Ответ [1]",
      model: "test-model",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://llm.test/v1/chat/completions");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${KEY}`,
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "test-model",
      messages: ASK,
    });
  });

  it("sends a thinking mode only when one is set", async () => {
    const fetch = vi.fn(async () => reply("Ответ"));
    vi.stubGlobal("fetch", fetch);

    await chatCompletion(CONFIG, KEY, ASK);
    await chatCompletion({ ...CONFIG, thinking: "disabled" }, KEY, ASK);
    const bodies = sentBodies(fetch);
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(bodies[1].thinking).toEqual({ type: "disabled" });
  });

  it("sends OpenRouter's fallbacks and short hidden reasoning only to openrouter.ai", async () => {
    const fetch = vi.fn(async () => reply("Ответ", "b/fallback"));
    vi.stubGlobal("fetch", fetch);
    const models = ["b/fallback:free"];

    const routed = await chatCompletion(
      { baseUrl: "https://openrouter.ai/api/v1", model: "a/free:free", models },
      KEY,
      ASK,
    );
    await chatCompletion({ ...CONFIG, models }, KEY, ASK);
    await chatCompletion(
      { baseUrl: "https://openrouter.ai.evil.test/api/v1", model: "a", models },
      KEY,
      ASK,
    );
    const [openrouter, plain, lookalike] = sentBodies(fetch);
    expect(openrouter).toMatchObject({
      model: "a/free:free",
      models,
      reasoning: { effort: "low", exclude: true },
    });
    expect(routed).toEqual({ content: "Ответ", model: "b/fallback:free" });
    for (const body of [plain, lookalike]) {
      expect(body).not.toHaveProperty("models");
      expect(body).not.toHaveProperty("reasoning");
    }
  });

  it("leaves out an empty fallback list", async () => {
    const fetch = vi.fn(async () => reply("Ответ"));
    vi.stubGlobal("fetch", fetch);
    await chatCompletion(
      { baseUrl: "https://openrouter.ai/api/v1", model: "a", models: [] },
      KEY,
      ASK,
    );
    expect(sentBodies(fetch)[0]).not.toHaveProperty("models");
  });

  it("reports a rate limit with the time to wait", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("slow down", {
            status: 429,
            headers: { "retry-after": "3" },
          }),
      ),
    );
    const error = await failure(chatCompletion(CONFIG, KEY, ASK));
    expect(error).toMatchObject({
      reason: "rate-limited",
      status: 429,
      retryAfterMs: 3000,
    });
  });

  it("reports other HTTP errors, network errors and oversized bodies without details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`bad ${KEY}`, { status: 401 })),
    );
    expect(await failure(chatCompletion(CONFIG, KEY, ASK))).toMatchObject({
      reason: "http",
      status: 401,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED ${KEY}`);
      }),
    );
    expect(await failure(chatCompletion(CONFIG, KEY, ASK))).toMatchObject({
      reason: "network",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply("x".repeat(600 * 1024))),
    );
    expect(await failure(chatCompletion(CONFIG, KEY, ASK))).toMatchObject({
      reason: "response",
    });
  });

  it("gives up after the timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "TimeoutError")),
            );
          }),
      ),
    );
    expect(
      await failure(chatCompletion(CONFIG, KEY, ASK, { timeoutMs: 20 })),
    ).toMatchObject({ reason: "timeout" });
  });
});
