import { describe, expect, it } from "vite-plus/test";
import type { CardMeta } from "./card-types";
import { draftToPatch, toMetaDraft } from "./meta-draft";

const meta: CardMeta = {
  mirrored: false,
  kind: "task",
  severity: null,
  backlogId: "T-1",
  halfBaked: false,
  report: null,
  notionPageId: null,
  notionStatus: null,
  executor: null,
  branch: "fix/a",
  pullRequests: ["#1"],
  files: [],
  tokens: 100,
  costUsd: null,
  contextPack: null,
  updatedBy: null,
  updatedAt: null,
};

describe("draftToPatch", () => {
  it("sends nothing when nothing changed", () => {
    expect(draftToPatch(meta, toMetaDraft(meta))).toEqual({
      patch: {},
      invalid: [],
    });
  });

  it("sends only changed fields, empty text as null, lists by line", () => {
    const draft = {
      ...toMetaDraft(meta),
      kind: "bug" as const,
      backlogId: "  ",
      files: "a.ts\n\n b.ts:12 \n",
      tokens: "250",
      costUsd: "1,5",
    };
    expect(draftToPatch(meta, draft)).toEqual({
      patch: {
        kind: "bug",
        backlogId: null,
        files: ["a.ts", "b.ts:12"],
        tokens: 250,
        costUsd: 1.5,
      },
      invalid: [],
    });
  });

  it("reports numbers the API would refuse", () => {
    const draft = { ...toMetaDraft(meta), tokens: "1.5", costUsd: "-2" };
    expect(draftToPatch(meta, draft).invalid).toEqual(["tokens", "costUsd"]);
  });
});
