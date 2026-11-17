import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { encodeCursor } from "../forest/read/page-cursor";
import { maskPageForTokenCaller } from "./token-caller-text";

// TB-143: every response of these routers reaches a caller with a token
// through maskForTokenCaller. Upload routes answer with presigned or asset
// URLs, not with card text, and a masked URL would no longer work.
const ROUTERS = [
  "task/index.ts",
  "comment/index.ts",
  "activity/index.ts",
  "search/index.ts",
];
const NO_TEXT = new Set([
  "stagedUploadRoute",
  "finalizeStagedUploadRoute",
  "createTaskImageUploadRoute",
  "finalizeTaskImageUploadRoute",
]);

describe("responses for callers with a token go through the mask (TB-143)", () => {
  for (const file of ROUTERS) {
    it(`wraps every c.json in ${file}`, () => {
      const source = readFileSync(join(__dirname, "..", file), "utf8");
      const handlers = source.split(/\.openapi\(/).slice(1);
      expect(handlers.length).toBeGreaterThan(0);

      const unmasked = handlers
        .map((handler) => ({
          route: handler.match(/^\s*(\w+)/)?.[1] ?? "?",
          calls: [...handler.matchAll(/c\.json\(\s*(\S+)/g)].map((m) => m[1]),
        }))
        .filter(({ route }) => !NO_TEXT.has(route))
        .filter(({ calls }) =>
          calls.some((arg) => !arg?.startsWith("maskForTokenCaller(")),
        )
        .map(({ route }) => route);

      expect(unmasked).toEqual([]);
    });
  }
});

// TB-204: redact reads a page cursor (base64url, 66 characters) as a base64
// secret; a masked cursor fails the next page with 400.
describe("maskPageForTokenCaller (TB-204)", () => {
  const secret = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
  const cursor = encodeCursor({
    at: new Date("2026-11-15T09:00:00.000Z"),
    id: "x7k2m9p4q8r1s5t3v6w0y2z4",
  });
  const page = { items: [{ note: `key ${secret}` }], nextCursor: cursor };
  const app = new Hono().get("/", (c) =>
    c.json(maskPageForTokenCaller(c, page)),
  );
  const read = async (headers: Record<string, string>) =>
    (await app.request("/", { headers })).json();

  it("masks the items and keeps the cursor for a caller with a token", async () => {
    const body = await read({ "x-api-key": "key" });
    expect(body.nextCursor).toBe(cursor);
    expect(JSON.stringify(body.items)).not.toContain(secret);
  });

  it("answers a caller without a token as it is", async () => {
    expect(await read({})).toEqual(page);
  });
});
