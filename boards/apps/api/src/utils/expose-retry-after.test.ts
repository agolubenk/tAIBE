import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { applyApiKeyHeaders } from "./apply-api-key-headers";
import { exposeRetryAfter } from "./expose-retry-after";

type Variables = { apiKeyHeaders?: Record<string, string> };

function appWith(
  status: number,
  headers: Record<string, string>,
  apiKeyHeaders?: Record<string, string>,
) {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", exposeRetryAfter);
  app.use("*", applyApiKeyHeaders);
  app.get("/", (c) => {
    if (apiKeyHeaders) c.set("apiKeyHeaders", apiKeyHeaders);
    return new Response("{}", { status, headers });
  });
  return app;
}

describe("exposeRetryAfter", () => {
  it("copies X-Retry-After of a 429 into Retry-After", async () => {
    const response = await appWith(429, { "X-Retry-After": "42" }).request("/");

    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("x-retry-after")).toBe("42");
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("keeps a Retry-After that is already set", async () => {
    const response = await appWith(429, {
      "Retry-After": "5",
      "X-Retry-After": "9",
    }).request("/");

    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("leaves other answers alone", async () => {
    const ok = await appWith(200, { "X-Retry-After": "42" }).request("/");
    const plain = await appWith(429, {}).request("/");

    expect(ok.headers.get("retry-after")).toBeNull();
    expect(plain.headers.get("retry-after")).toBeNull();
  });

  it("runs after the API-key headers, so the key answer stays private", async () => {
    const response = await appWith(
      429,
      { "X-Retry-After": "42" },
      { "Retry-After": "42" },
    ).request("/");

    expect(response.headers.get("retry-after")).toBe("42");
    expect(response.headers.get("cache-control")).toBe("private");
  });
});
