import { describe, expect, it } from "vite-plus/test";
import { createJsonClient, SourceHttpError } from "./http.js";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch, maxRetries = 2) {
  return createJsonClient({
    service: "Test",
    baseUrl: "https://example.test",
    headers: () => ({}),
    fetch: fetchImpl as unknown as typeof fetch,
    maxRetries,
  });
}

describe("createJsonClient retries", () => {
  it("retries a 502 and succeeds on the next attempt", async () => {
    let calls = 0;
    const http = client(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? jsonResponse({ message: "bad gateway" }, 502)
          : jsonResponse({ ok: true }),
      );
    });
    await expect(http.request("/v1/thing")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("gives up after maxRetries 5xx attempts and reports the status", async () => {
    let calls = 0;
    const http = client(() => {
      calls += 1;
      return Promise.resolve(jsonResponse({ message: "down" }, 503));
    });
    await expect(http.request("/v1/thing")).rejects.toBeInstanceOf(
      SourceHttpError,
    );
    // 1 request + 2 retries with maxRetries = 2.
    expect(calls).toBe(3);
  });

  it("does not retry a 4xx", async () => {
    let calls = 0;
    const http = client(() => {
      calls += 1;
      return Promise.resolve(jsonResponse({ message: "nope" }, 404));
    });
    await expect(http.request("/v1/thing")).rejects.toBeInstanceOf(
      SourceHttpError,
    );
    expect(calls).toBe(1);
  });

  it("still retries 429", async () => {
    let calls = 0;
    const http = client(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response("{}", { status: 429, headers: { "Retry-After": "0" } })
          : jsonResponse({ ok: true }),
      );
    });
    await expect(http.request("/v1/thing")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
