import { describe, expect, it } from "vite-plus/test";
import { redactContextApproval, redactContextMeta } from "./redact-context";

// A fake token assembled at runtime, so this file holds no key-shaped literal.
const SECRET = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

const meta = {
  report: null,
  executor: null,
  branch: null,
  pullRequests: [] as string[],
  files: [] as string[],
  contextPack: null,
};

describe("redact-context (TB-141)", () => {
  it("passes a jsonb value that is not a string as it is, instead of throwing", () => {
    // jsonb is typed, not checked: an odd row must not turn the pack into a 500.
    const params = { status: "done", count: 3, flag: null, note: SECRET };
    const approval = redactContextApproval({
      reason: null,
      params: params as unknown as Record<string, string>,
    });
    expect(approval.params).toEqual({
      status: "done",
      count: 3,
      flag: null,
      note: "[REDACTED:api_key]",
    });

    const fields = redactContextMeta({
      ...meta,
      pullRequests: [7, SECRET] as unknown as string[],
      files: [{ path: "a" }, `notes/${SECRET}.md`] as unknown as string[],
    });
    expect(fields.pullRequests).toEqual([7, "[REDACTED:api_key]"]);
    expect(fields.files).toEqual([
      { path: "a" },
      "notes/[REDACTED:api_key].md",
    ]);
  });
});
