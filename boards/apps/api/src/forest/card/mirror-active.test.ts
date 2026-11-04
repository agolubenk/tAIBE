import { describe, expect, it } from "vite-plus/test";
import { toCardMeta } from "./card-meta";
import { isMirrorActive } from "./mirror-active";

const BASE = {
  NOTION_MIRROR_WORKSPACE_ID: "ws-1",
  NOTION_MIRROR_TOKEN_FILE: "/tmp/token",
  NOTION_MIRROR_DATABASES: "db-a",
} as const;

describe("isMirrorActive", () => {
  it("is off without a mirror config", () => {
    expect(isMirrorActive("ws-1", {})).toBe(false);
  });

  it("is on only for the workspace the mirror serves", () => {
    expect(isMirrorActive("ws-1", { ...BASE })).toBe(true);
    expect(isMirrorActive("ws-2", { ...BASE })).toBe(false);
  });
});

describe("toCardMeta mirrored", () => {
  it("marks a Notion-imported card only while the mirror runs", () => {
    const row = {
      taskId: "t1",
      workspaceId: "ws-1",
      kind: "task",
      severity: null,
      backlogId: null,
      halfBaked: true,
      report: null,
      notionPageId: "page-1",
      notionStatus: null,
      notionEditedAt: new Date(),
      executor: null,
      branch: null,
      pullRequests: [],
      files: [],
      tokens: null,
      costUsd: null,
      contextPack: null,
      updatedBy: "u1",
      updatedAt: new Date(),
    } satisfies Parameters<typeof toCardMeta>[1];
    expect(toCardMeta("t1", row, true).mirrored).toBe(true);
    expect(toCardMeta("t1", row, false).mirrored).toBe(false);
    expect(toCardMeta("t1").mirrored).toBe(false);
  });
});

