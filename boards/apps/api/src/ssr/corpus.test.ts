import { describe, expect, it } from "vite-plus/test";
import { entityOfPath, isCorpusPath } from "./corpus";

describe("ssr corpus", () => {
  it("reads the eval tree in the incubator layout and in the product home", () => {
    for (const root of ["supertick-eval", "eval"]) {
      expect(entityOfPath(`${root}/pipeline/genome/coord.json`)).toEqual({
        kind: "genome",
        name: "coord.json",
        path: `${root}/pipeline/genome/coord.json`,
      });
      expect(entityOfPath(`${root}/prompts/launch-3010/README.md`)?.kind).toBe(
        "prompt",
      );
      expect(entityOfPath(`${root}/nerve/config.json`)?.name).toBe(
        "config.json",
      );
    }
  });

  it("keeps paths outside the registry out, so push-back refuses them", () => {
    expect(isCorpusPath("evaluation/prompts/x.md")).toBe(false);
    expect(isCorpusPath("boards/eval/nerve/x.py")).toBe(false);
    expect(isCorpusPath("eval/data/run.jsonl")).toBe(false);
  });

  it("takes task-folder templates by file name without the extension (TB-163)", () => {
    for (const file of ["brief", "review", "cloud-question"]) {
      expect(entityOfPath(`.ai/templates/${file}.md`)).toEqual({
        kind: "template",
        name: file,
        path: `.ai/templates/${file}.md`,
      });
    }
    // Live task folders and nested files stay out of the registry.
    expect(isCorpusPath(".ai/task/tb-163/brief.md")).toBe(false);
    expect(isCorpusPath(".ai/templates/old/brief.md")).toBe(false);
    expect(isCorpusPath(".ai/templates/.gitkeep")).toBe(false);
  });

  it("folds a skill's files into its folder entity", () => {
    expect(entityOfPath(".claude/skills/grill-task/protocol.md")).toEqual({
      kind: "skill",
      name: "grill-task",
      path: ".claude/skills/grill-task",
    });
  });
});
