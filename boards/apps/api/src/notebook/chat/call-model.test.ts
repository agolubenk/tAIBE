import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vite-plus/test";
import type { ModelChain } from "../../notebook-model/effective-notebook-model";
import {
  CHAIN_DEADLINE_MS,
  callModel,
  failsSinceStart,
  resetModelFails,
} from "./call-model";

const ASK = [{ role: "user" as const, content: "Что такое аренда?" }];

const CHAIN: ModelChain = [
  {
    id: "main",
    baseUrl: "https://a.test/v1",
    model: "a-model",
    models: [],
    key: "sk-key-of-a",
  },
  {
    id: "p2",
    baseUrl: "https://b.test/v1",
    model: "b-model",
    models: [],
    key: "sk-key-of-b",
  },
];

const KEYS: Record<string, string> = {
  "https://a.test/v1/chat/completions": "sk-key-of-a",
  "https://b.test/v1/chat/completions": "sk-key-of-b",
};

const answer = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { "content-type": "application/json" },
  });

const limited = (seconds: number) =>
  new Response("slow down", {
    status: 429,
    headers: { "retry-after": String(seconds) },
  });

type Script = Record<string, (() => Response)[]>;

// Answers each address from its own list in turn; a key sent to the wrong
// address fails the test.
function stubFetch(script: Script) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth).toBe(`Bearer ${KEYS[url]}`);
    const next = script[url]?.shift();
    if (!next) throw new Error(`unexpected call to ${url}`);
    return next();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const urls = (fetch: ReturnType<typeof stubFetch>) =>
  fetch.mock.calls.map(([url]) => url);

describe("callModel", () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    resetModelFails();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("answers from the first point and never calls the next", async () => {
    const fetch = stubFetch({
      "https://a.test/v1/chat/completions": [() => answer("Ответ A")],
    });
    expect(await callModel(CHAIN, ASK)).toEqual({
      ok: true,
      content: "Ответ A",
      model: "a-model",
    });
    expect(urls(fetch)).toEqual(["https://a.test/v1/chat/completions"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("moves to the next point past the rate-limit window", async () => {
    const fetch = stubFetch({
      "https://a.test/v1/chat/completions": [() => limited(60)],
      "https://b.test/v1/chat/completions": [() => answer("Ответ B")],
    });
    expect(await callModel(CHAIN, ASK)).toEqual({
      ok: true,
      content: "Ответ B",
      model: "b-model",
    });
    expect(urls(fetch)).toEqual([
      "https://a.test/v1/chat/completions",
      "https://b.test/v1/chat/completions",
    ]);
    expect(failsSinceStart("main")).toBe(1);
    expect(failsSinceStart("p2")).toBe(0);
  });

  it("waits out a short rate limit once on the same point", async () => {
    const fetch = stubFetch({
      "https://a.test/v1/chat/completions": [
        () => limited(0),
        () => answer("Ответ A"),
      ],
    });
    expect(await callModel(CHAIN, ASK)).toMatchObject({
      ok: true,
      model: "a-model",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(failsSinceStart("main")).toBe(0);
  });

  it.each([
    ["an empty answer", () => answer("   ")],
    ["a server error", () => new Response("down", { status: 503 })],
    ["a refused key", () => new Response("no", { status: 401 })],
  ])("moves on after %s", async (_name, failure) => {
    stubFetch({
      "https://a.test/v1/chat/completions": [failure],
      "https://b.test/v1/chat/completions": [() => answer("Ответ B")],
    });
    expect(await callModel(CHAIN, ASK)).toMatchObject({
      ok: true,
      model: "b-model",
    });
  });

  it("reports limited only when every point was rate-limited", async () => {
    stubFetch({
      "https://a.test/v1/chat/completions": [() => limited(60)],
      "https://b.test/v1/chat/completions": [() => limited(60)],
    });
    expect(await callModel(CHAIN, ASK)).toEqual({
      ok: false,
      limited: true,
      model: "b-model",
    });

    stubFetch({
      "https://a.test/v1/chat/completions": [() => limited(60)],
      "https://b.test/v1/chat/completions": [
        () => new Response("down", { status: 503 }),
      ],
    });
    expect(await callModel(CHAIN, ASK)).toEqual({
      ok: false,
      limited: false,
      model: "b-model",
    });
    expect(failsSinceStart("main")).toBe(2);
    expect(failsSinceStart("p2")).toBe(2);
  });

  it("logs each failure with the point, its origin, the model and the reason, never the key", async () => {
    stubFetch({
      "https://a.test/v1/chat/completions": [
        () => new Response("down", { status: 503 }),
      ],
      "https://b.test/v1/chat/completions": [() => answer("   ")],
    });
    await callModel(CHAIN, ASK);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([
      "Notebook model point 1/2 (https://a.test, a-model) failed: http 503; moving to point 2",
      "Notebook model point 2/2 (https://b.test, b-model) failed: response; no point left",
    ]);
    for (const line of lines) {
      expect(line).not.toContain("sk-key");
      expect(line).not.toContain("/v1");
    }
  });

  it("stops at the chain's deadline and records the last point it tried", async () => {
    const start = Date.now();
    stubFetch({
      "https://a.test/v1/chat/completions": [
        () => {
          vi.spyOn(Date, "now").mockReturnValue(start + CHAIN_DEADLINE_MS + 1);
          return new Response("down", { status: 503 });
        },
      ],
    });
    expect(await callModel(CHAIN, ASK)).toEqual({
      ok: false,
      limited: false,
      model: "a-model",
    });
    expect(String(warn.mock.calls[0]?.[0])).toContain("no point left");
  });
});
