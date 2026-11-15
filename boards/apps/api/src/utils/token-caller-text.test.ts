import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

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
