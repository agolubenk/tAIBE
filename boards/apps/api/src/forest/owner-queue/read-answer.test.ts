import { describe, expect, it } from "vite-plus/test";
import type { QueueDoc, QueueEvent } from "./queue-client";
import { readOwnerQueueConfig } from "./queue-config";
import { approvalItemId } from "./item-text";
import { readAnswer } from "./read-answer";

const check = (data: Record<string, unknown>): QueueDoc => ({
  id: "d-tba-a-x",
  data,
  version: 3,
  updatedAt: 0,
});
const event = (
  at: number,
  actor: string,
  after: Record<string, unknown>,
): QueueEvent => ({ at, actor, action: "update", after });

describe("readAnswer (TB-102 R-2, R-3)", () => {
  it("takes the time and author of the write that set the choice", () => {
    const answer = readAnswer(check({ done: true, choice: "yes", at: 1 }), [
      event(300, "t-boards", { choice: "yes", agentStatus: "done" }),
      event(200, "owner", { choice: "yes", done: true }),
      event(100, "t-boards", { agentNote: "x" }),
    ]);
    expect(answer).toEqual({
      kind: "yes",
      answeredAt: new Date(200),
      answeredBy: "owner",
      note: undefined,
    });
  });

  // The queue journal keeps the whole document after each write
  // (ops-console store.ts:353): a later note edit keeps the choice in «after».
  it("keeps the time of the choice when the owner edits the note later", () => {
    const answer = readAnswer(check({ choice: "yes", note: "позже" }), [
      event(500, "owner", { choice: "yes", note: "позже" }),
      event(200, "owner", { choice: "yes" }),
      event(100, "t-boards", {}),
    ]);
    expect(answer.kind === "yes" && answer.answeredAt.getTime()).toBe(200);
  });

  it("ignores the browser «at» field", () => {
    const answer = readAnswer(check({ choice: "no", at: 999_999 }), [
      event(50, "owner", { choice: "no" }),
    ]);
    expect(answer.kind === "no" && answer.answeredAt.getTime()).toBe(50);
  });

  it("reads a tick without a choice as undecided", () => {
    expect(readAnswer(check({ done: true }), [])).toEqual({
      kind: "undecided",
    });
  });

  it("waits while the journal does not show the choice yet", () => {
    expect(readAnswer(check({ choice: "yes" }), [])).toEqual({
      kind: "unconfirmed",
    });
  });

  it("reads no answer from a missing check", () => {
    expect(readAnswer(null, [])).toEqual({ kind: "none" });
  });
});

describe("owner-queue config and item id", () => {
  it("is off without the token name or a workspace pair (AC-14)", () => {
    const base = {
      OQ_URL: "https://ops.test/",
      OQ_TOKEN_FILE: "/run/secrets/oq",
      OQ_TOKEN_NAME: "t-boards",
      OQ_WORKSPACE_PRODUCTS: "ws1=hr-helper, ws2=taibe",
    };
    expect(readOwnerQueueConfig({ ...base, OQ_TOKEN_NAME: "" })).toBeNull();
    expect(
      readOwnerQueueConfig({ ...base, OQ_WORKSPACE_PRODUCTS: "" }),
    ).toBeNull();
    const config = readOwnerQueueConfig(base);
    expect(config?.url).toBe("https://ops.test");
    expect([...(config?.products ?? [])]).toEqual([
      ["ws1", "hr-helper"],
      ["ws2", "taibe"],
    ]);
  });

  it("prefixes the item id by product (F19)", () => {
    expect(approvalItemId("hr-helper", "abc", "n0nce1")).toBe(
      "d-tba-abc-n0nce1",
    );
    expect(approvalItemId("taibe", "abc", "n0nce1")).toBe(
      "taibe-d-tba-abc-n0nce1",
    );
  });
});
