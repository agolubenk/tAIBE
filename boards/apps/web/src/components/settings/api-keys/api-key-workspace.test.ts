import { describe, expect, it } from "vite-plus/test";
import {
  ALL_WORKSPACES,
  apiKeyMetadata,
  apiKeyWorkspaceMetadata,
  isReadOnlyApiKey,
  readApiKeyWorkspace,
} from "./api-key-workspace";

describe("apiKeyWorkspaceMetadata", () => {
  it("sends no metadata for an all-workspaces key", () => {
    expect(apiKeyWorkspaceMetadata(ALL_WORKSPACES)).toBeUndefined();
    expect(apiKeyWorkspaceMetadata("ws-a")).toEqual({ workspaceId: "ws-a" });
  });
});

describe("apiKeyMetadata (TB-96)", () => {
  it("adds access read only to a read-only key", () => {
    expect(apiKeyMetadata(ALL_WORKSPACES, false)).toBeUndefined();
    expect(apiKeyMetadata("ws-a", false)).toEqual({ workspaceId: "ws-a" });
    expect(apiKeyMetadata(ALL_WORKSPACES, true)).toEqual({ access: "read" });
    expect(apiKeyMetadata("ws-a", true)).toEqual({
      workspaceId: "ws-a",
      access: "read",
    });
  });
});

describe("isReadOnlyApiKey (TB-96)", () => {
  it("is false for keys without the field", () => {
    for (const metadata of [
      null,
      undefined,
      "null",
      {},
      { workspaceId: "ws-a" },
      { access: "full" },
    ]) {
      expect(isReadOnlyApiKey(metadata), JSON.stringify(metadata)).toBe(false);
    }
  });

  it("is true for access read and, like the API, for unknown values", () => {
    for (const metadata of [
      { access: "read" },
      JSON.stringify({ access: "read", workspaceId: "ws-a" }),
      JSON.stringify(JSON.stringify({ access: "read" })),
      { access: "write" },
      "{oops",
      "[]",
    ]) {
      expect(isReadOnlyApiKey(metadata), JSON.stringify(metadata)).toBe(true);
    }
  });
});

describe("readApiKeyWorkspace", () => {
  it("returns null for a key without a workspace", () => {
    for (const metadata of [null, undefined, "null", {}, '{"note":"ci"}']) {
      expect(readApiKeyWorkspace(metadata)).toBeNull();
    }
  });

  it("reads parsed, stored and double-encoded metadata", () => {
    const stored = JSON.stringify({ workspaceId: "ws-a" });
    expect(readApiKeyWorkspace({ workspaceId: "ws-a" })).toBe("ws-a");
    expect(readApiKeyWorkspace(stored)).toBe("ws-a");
    expect(readApiKeyWorkspace(JSON.stringify(stored))).toBe("ws-a");
  });

  it("marks unreadable metadata as scoped to an unknown workspace", () => {
    for (const metadata of ["{oops", "[]", '{"workspaceId":7}']) {
      expect(readApiKeyWorkspace(metadata)).toBe("");
    }
  });
});
