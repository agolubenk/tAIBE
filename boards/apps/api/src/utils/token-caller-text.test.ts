import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { type Context, Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { ApiError } from "../errors/api-error";
import {
  refuseMarkerForTokenCaller,
  restoreEachForTokenCaller,
} from "./token-caller-text";

// TB-143: every response of these routers reaches a caller with a token
// through maskForTokenCaller. Upload routes answer with presigned or asset
// URLs, not with card text, and a masked URL would no longer work.
const ROUTERS = [
  "task/index.ts",
  "comment/index.ts",
  "activity/index.ts",
  "search/index.ts",
  // TB-178: label names, field values and link URLs are masked on their own
  // routes too, so a key sees no secret in any answer.
  "label/index.ts",
  "custom-field/index.ts",
  "external-link/index.ts",
  // Reads that show card text and have no write-back of that text. Meta,
  // work state, approvals, leases and logs stay raw: an agent writes them and
  // their write routes restore no marker.
  "notification/index.ts",
  "task-relation/index.ts",
  "forest/routes/tree-routes.ts",
  "forest/routes/graph-routes.ts",
  "forest/routes/bugs-routes.ts",
  "forest/routes/memory-routes.ts",
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
      const source = readFileSync(joinPath(__dirname, "..", file), "utf8");
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

// Fake secrets assembled at runtime, so this file holds no key-shaped literal.
const join = (...parts: string[]) => parts.join("");
const SECRET = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const SECRET_2 = join("gh", "p_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2");
const MARK = "[REDACTED:api_key]";

// Runs a helper inside a request, as a route does; x-api-key makes the
// caller a caller with a token.
async function inRequest<T>(
  token: boolean,
  run: (c: Context) => Promise<T> | T,
): Promise<{ value?: T; error?: unknown }> {
  const app = new Hono();
  let out: { value?: T; error?: unknown } = {};
  app.get("/", async (c) => {
    try {
      out = { value: await run(c) };
    } catch (error) {
      out = { error };
    }
    return c.body(null, 204);
  });
  await app.request("/", { headers: token ? { "x-api-key": "k" } : {} });
  return out;
}

describe("restoreEachForTokenCaller (TB-144)", () => {
  it("gives each masked option a stored value, in stored order, wherever it moved", async () => {
    const stored = ["prod", SECRET, SECRET_2];
    const kept = await inRequest(true, (c) =>
      restoreEachForTokenCaller(c, ["prod", MARK, MARK], async () => stored),
    );
    expect(kept.value).toEqual(["prod", SECRET, SECRET_2]);
    const moved = await inRequest(true, (c) =>
      restoreEachForTokenCaller(c, [MARK, "new", "prod"], async () => [
        "prod",
        SECRET,
      ]),
    );
    expect(moved.value).toEqual([SECRET, "new", "prod"]);
  });

  it("refuses with 409 a masked option that no stored value is left for", async () => {
    const { error } = await inRequest(true, (c) =>
      restoreEachForTokenCaller(c, [MARK, MARK], async () => [SECRET]),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "REDACTED_MARKERS_MISMATCH",
    });
  });

  it("reads nothing stored without a token or without a marker", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [SECRET];
    };
    const browser = await inRequest(false, (c) =>
      restoreEachForTokenCaller(c, [MARK], load),
    );
    expect(browser.value).toEqual([MARK]);
    const plain = await inRequest(true, (c) =>
      restoreEachForTokenCaller(c, ["a", "b"], load),
    );
    expect(plain.value).toEqual(["a", "b"]);
    expect(loads).toBe(0);
  });
});

describe("refuseMarkerForTokenCaller (TB-144)", () => {
  it("refuses a marker in a new value from a caller with a token", async () => {
    const { error } = await inRequest(true, (c) =>
      refuseMarkerForTokenCaller(c, `x ${MARK}`, "Hint."),
    );
    expect(error).toMatchObject({
      status: 409,
      code: "REDACTED_MARKERS_MISMATCH",
      message: expect.stringContaining("Hint."),
    });
  });

  it("lets a browser session, a value without a marker and no value through", async () => {
    for (const [token, value] of [
      [false, MARK],
      [true, "plain"],
      [true, undefined],
    ] as const) {
      const { error } = await inRequest(token, (c) =>
        refuseMarkerForTokenCaller(c, value, "Hint."),
      );
      expect(error).toBeUndefined();
    }
  });
});
