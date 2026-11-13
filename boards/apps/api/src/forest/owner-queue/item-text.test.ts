import { describe, expect, it } from "vite-plus/test";
import { approvalItemData, type ItemApproval } from "./item-text";

const approval = (over: Partial<ItemApproval> = {}): ItemApproval => ({
  id: "a1",
  action: "close_task",
  params: { status: "done" },
  reason: "сделано",
  requestedByName: "t3-boards · Claude Code",
  expiresAt: new Date("2026-11-14T07:54:27Z"),
  doneRef: null,
  doneReason: null,
  ...over,
});

const item = (over: Partial<ItemApproval> = {}) =>
  approvalItemData({
    approval: approval(over),
    workspaceName: "aiBoards&eval",
    card: { key: "TB-105", title: "t", current: "In Review" },
    now: new Date("2026-11-13T07:54:27Z"),
  });

// Same shape as the ops-console item schema (store.ts httpsLink): a link is an
// object with an https href; a bare string is a 422 for the whole item (TB-109).
const isQueueLink = (link: unknown) =>
  typeof link === "object" &&
  link !== null &&
  typeof (link as { href?: unknown }).href === "string" &&
  /^https:\/\/[^\s"<>]+$/.test((link as { href: string }).href);

describe("approvalItemData links (TB-109)", () => {
  it("sends doneRef as a link object the ops-console accepts", () => {
    const ref = "https://github.com/agolubenk/tAIBE/pull/145";
    const data = item({ doneRef: ref });
    expect(data.links).toEqual([{ href: ref, text: "Журнал закрытых" }]);
    expect((data.links as unknown[]).every(isQueueLink)).toBe(true);
  });

  it("sends no links without doneRef", () => {
    expect(item({ doneReason: "obsolete" })).not.toHaveProperty("links");
    expect(item()).not.toHaveProperty("links");
  });
});
