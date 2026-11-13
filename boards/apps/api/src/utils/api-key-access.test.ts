import { describe, expect, it } from "vite-plus/test";
import { keyAccessAllowsMethod, parseApiKeyAccess } from "./api-key-access";

describe("parseApiKeyAccess (TB-96)", () => {
  it("keeps full access for keys without the field", () => {
    for (const metadata of [
      undefined,
      null,
      "null",
      {},
      { workspaceId: "ws-a" },
      JSON.stringify({ workspaceId: "ws-a" }),
      { access: "full" },
    ]) {
      expect(parseApiKeyAccess(metadata), JSON.stringify(metadata)).toBe(
        "full",
      );
    }
  });

  it("reads only for access read, also double-encoded", () => {
    for (const metadata of [
      { access: "read" },
      { access: "read", workspaceId: "ws-a" },
      JSON.stringify({ access: "read" }),
      JSON.stringify(JSON.stringify({ access: "read" })),
    ]) {
      expect(parseApiKeyAccess(metadata), JSON.stringify(metadata)).toBe(
        "read",
      );
    }
  });

  it("fails closed on unknown values and unreadable metadata", () => {
    for (const metadata of [
      { access: "write" },
      { access: "READ" },
      { access: null },
      { access: true },
      "{not json",
      "[]",
      42,
    ]) {
      expect(parseApiKeyAccess(metadata), JSON.stringify(metadata)).toBe(
        "read",
      );
    }
  });
});

describe("keyAccessAllowsMethod (TB-96)", () => {
  it("lets a read-only key use only GET and HEAD", () => {
    for (const method of ["GET", "HEAD", "get", "head"]) {
      expect(keyAccessAllowsMethod("read", method), method).toBe(true);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "post"]) {
      expect(keyAccessAllowsMethod("read", method), method).toBe(false);
    }
  });

  it("does not limit full keys and sessions", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(keyAccessAllowsMethod("full", method), method).toBe(true);
      expect(keyAccessAllowsMethod(undefined, method), method).toBe(true);
    }
  });
});
