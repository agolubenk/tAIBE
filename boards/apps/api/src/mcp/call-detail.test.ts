import { describe, expect, it } from "vite-plus/test";
import { callDetail, callTarget } from "./call-detail";

const call = { tool: "get_task", ok: true, bytes: 120, tokens: 30, ms: 4 };

describe("callDetail", () => {
  it("names the tool and keeps the sizes and the sent arguments", () => {
    const detail = JSON.parse(callDetail({ ...call, args: { id: "t1" } }));

    expect(detail).toEqual({
      tool: "get_task",
      bytes: 120,
      tokens: 30,
      ms: 4,
      args: '{"id":"t1"}',
    });
  });

  it("replaces a secret in the arguments with a label", () => {
    const secret = "postgres://probe:not-a-real-pass@db.local:5432/x";
    const detail = callDetail({ ...call, args: { description: secret } });

    expect(detail).not.toContain("not-a-real-pass");
    expect(detail).toContain("[REDACTED:db_url]");
  });

  it("cuts long arguments and stays valid JSON under the journal limit", () => {
    const detail = callDetail({
      ...call,
      args: { text: "word ".repeat(2000) },
    });

    expect(detail.length).toBeLessThanOrEqual(2000);
    expect(JSON.parse(detail).args.endsWith("…")).toBe(true);
  });

  it("measures the cut after escaping, so quotes cannot overflow it", () => {
    const detail = callDetail({ ...call, args: { text: '"'.repeat(3000) } });

    expect(detail.length).toBeLessThanOrEqual(2000);
    expect(JSON.parse(detail).args.endsWith("…")).toBe(true);
  });
});

// TB-44: a call about a card is filed under it; the tool stays in the detail.
describe("callTarget", () => {
  it("files an answered call that names a card by taskId under the card", () => {
    expect(callTarget({ ...call, args: { taskId: "abc123_X-9" } })).toEqual({
      targetType: "task",
      targetId: "abc123_X-9",
    });
  });

  it("keeps the tool for a refused call, a call without taskId and a taskId that is no id", () => {
    const tool = { targetType: "mcp_tool", targetId: "get_task" };
    const target = (args: unknown, ok = true) =>
      callTarget({ ...call, ok, args });

    expect(target({ taskId: "abc" }, false)).toEqual(tool);
    expect(target({ ticketId: "TB-1" })).toEqual(tool);
    expect(target(null)).toEqual(tool);
    expect(target({ taskId: 42 })).toEqual(tool);
    expect(target({ taskId: "postgres://u:p@db.local:5432/x" })).toEqual(tool);
    expect(target({ taskId: "a".repeat(65) })).toEqual(tool);
  });
});
