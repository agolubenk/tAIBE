import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

// TB-173 (#357 bundle): the web loads only these modules at runtime. With
// "sideEffects": false the bundler then drops the zod schemas; a value import
// of zod or of a schema module here would pull them into the web's chunks.
const WEB_MODULES = ["answers", "export", "limits", "show-if"];
const RUNTIME_FROM = /^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm;

const runtimeFrom = (name: string) => {
  const file = new URL(`./${name}.ts`, import.meta.url);
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(RUNTIME_FROM)].map((hit) => hit[1] ?? "");
};

describe("modules the web loads (TB-173)", () => {
  it.each(WEB_MODULES)("%s.ts imports no zod and no schema", (name) => {
    const from = runtimeFrom(name);
    expect(from.filter((path) => /^zod$|schema/.test(path))).toEqual([]);
  });

  it("sees the zod import of schema.ts, so the check is not empty", () => {
    expect(runtimeFrom("schema")).toContain("zod");
  });
});
