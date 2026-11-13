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

describe("approvalItemData for a batch close (TB-108 R-5)", () => {
  const keys = Array.from({ length: 12 }, (_, i) =>
    i < 8 ? `APP-${i + 1}` : `HRH-${i + 1}`,
  );
  const batch = approvalItemData({
    approval: approval({
      params: {
        taskIds: keys.join(","),
        keys: keys.join(","),
        from: "",
        targets: "",
      },
      doneReason: "import",
    }),
    workspaceName: "HR Helper / Lavaeon",
    card: null,
    taskKeys: keys.slice(0, 10).map((key) => `${key} «t»`),
    now: new Date("2026-11-13T07:54:27Z"),
  });

  // Control lens on #160: the owner sees every key of the request before
  // «да», not only the first 10.
  it("shows counts per project, the first 10 cards and every key", () => {
    const body = String(batch.body);
    expect(batch.title).toContain("закрыть карточки (12)");
    expect(body).toContain("Карточек: 12 — APP 8, HRH 4");
    expect(body).toContain("- HRH-10 «t»");
    expect(body).not.toContain("HRH-11 «t»");
    expect(body).toContain("- и ещё 2");
    expect(body).toContain(
      "Все карточки заявки:\nAPP: 1, 2, 3, 4, 5, 6, 7, 8\nHRH: 9, 10, 11, 12",
    );
    expect(body).toContain("перенесена в другой проект");
    expect(batch).not.toHaveProperty("links");
  });

  it("gives a single close no list of keys", () => {
    const single = approvalItemData({
      approval: approval(),
      workspaceName: "w",
      card: { key: "TB-1", title: "t", current: "In Review" },
      now: new Date(),
    });
    expect(String(single.body)).not.toContain("Все карточки заявки");
    expect(single).not.toHaveProperty("links");
  });
});
