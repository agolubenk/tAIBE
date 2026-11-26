import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

// TB-204: every forest response reaches a caller with a token through
// maskForTokenCaller, as the task routes do (TB-143), or a page through
// maskPageForTokenCaller (its cursor stays readable). A new route file or
// handler joins the check by itself.
const MASKED = /^mask(Page)?ForTokenCaller\(/;
//
// No stored text: a lease answers ids, a fence and times; a started mirror
// run answers its id.
const NO_TEXT = new Set([
  "acquireLeaseRoute",
  "releaseLeaseRoute",
  "startMirrorRunRoute",
]);
const ROUTE_FILES = readdirSync(__dirname).filter((file) =>
  file.endsWith("-routes.ts"),
);

describe("forest responses for callers with a token go through the mask (TB-204)", () => {
  it("checks every forest route file", () => {
    expect(ROUTE_FILES).toContain("read-routes.ts");
    expect(ROUTE_FILES.length).toBeGreaterThanOrEqual(17);
  });

  for (const file of ROUTE_FILES) {
    it(`wraps every c.json in ${file}`, () => {
      const source = readFileSync(join(__dirname, file), "utf8");
      const handlers = source.split(/\.openapi\(/).slice(1);
      expect(handlers.length).toBeGreaterThan(0);

      const unmasked = handlers
        .map((handler) => ({
          route: handler.match(/^\s*(\w+)/)?.[1] ?? "?",
          calls: [...handler.matchAll(/c\.json\(\s*(\S+)/g)].map((m) => m[1]),
        }))
        .filter(({ route }) => !NO_TEXT.has(route))
        .filter(({ calls }) => calls.some((arg) => !MASKED.test(arg ?? "")))
        .map(({ route }) => route);

      expect(unmasked).toEqual([]);
    });
  }
});
