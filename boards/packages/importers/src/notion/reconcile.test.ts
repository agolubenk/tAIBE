import { describe, expect, it } from "vite-plus/test";
import type { NotionDatabase, NotionPage } from "./api-types.js";
import { notionIdempotencyKey, pageIdFromKey } from "./idempotency.js";
import { mapDatabase } from "./mapping.js";
import { reconcile } from "./reconcile.js";

const DATABASE: NotionDatabase = {
  id: "db-1",
  title: [{ plain_text: "Bugs" }],
  properties: {
    Status: {
      id: "st",
      name: "Status",
      type: "status",
      status: {
        options: [
          { id: "o1", name: "Open" },
          { id: "o2", name: "Fixed" },
        ],
        groups: [{ name: "Complete", option_ids: ["o2"] }],
      },
    },
  },
};

function page(
  id: string,
  statusName: string,
  typeName: string,
  overrides: Partial<NotionPage> = {},
): NotionPage {
  return {
    object: "page",
    id,
    archived: false,
    created_time: "2026-10-01T09:00:00.000Z",
    last_edited_time: "2026-10-02T10:00:00.000Z",
    properties: {
      Name: { id: "t", type: "title", title: [{ plain_text: `Bug ${id}` }] },
      Status: { id: "st", type: "status", status: { name: statusName } },
      Type: { id: "ty", type: "select", select: { name: typeName } },
    },
    ...overrides,
  };
}

function imported(pages: NotionPage[]) {
  return mapDatabase(DATABASE, pages, new Map(), "hr").tasks;
}

describe("reconcile", () => {
  it("counts both sides by status and type and finds nothing on a clean import", () => {
    const pages = [
      page("a", "Open", "Bug"),
      page("b", "Fixed", "Bug"),
      page("c", "Open", "Task"),
    ];
    const report = reconcile(pages, imported(pages), DATABASE);

    expect(report.totals).toEqual({ source: 3, imported: 3 });
    expect(report.byStatus).toEqual({
      open: { source: 2, imported: 2 },
      fixed: { source: 1, imported: 1 },
    });
    expect(report.byType).toEqual({
      Bug: { source: 2, imported: 2 },
      Task: { source: 1, imported: 1 },
    });
    expect(report.discrepancies).toEqual([]);
  });

  it("names every kind of discrepancy by page", () => {
    const now = [
      page("a", "Fixed", "Bug"),
      page("b", "Open", "Bug", { in_trash: true }),
      page("new", "Open", "Bug"),
    ];
    const before = imported([
      page("a", "Open", "Bug"),
      page("b", "Open", "Bug"),
      page("gone", "Open", "Bug"),
    ]);

    const kinds = reconcile(now, before, DATABASE).discrepancies.map(
      ({ pageId, kind }) => `${pageId}:${kind}`,
    );

    expect(kinds).toEqual([
      "a:status-mismatch",
      "b:archive-mismatch",
      "new:missing-in-import",
      "gone:missing-in-source",
    ]);
  });

  it("does not flag a page Notion itself gives no status to", () => {
    const pages = [page("a", "", "Note")];
    const [task] = imported(pages);
    if (!task) throw new Error("expected a task");
    // The writer places statusless pages into the board's default column;
    // that placement must not read as a divergence from Notion.
    const placed = { ...task, columnKey: "kaneo:planned" };

    expect(reconcile(pages, [placed], DATABASE).discrepancies).toEqual([]);
  });

  it("still flags a page with a status whose card has no column", () => {
    const pages = [page("a", "Open", "Bug")];
    const [task] = imported(pages);
    if (!task) throw new Error("expected a task");
    const withoutColumn = { ...task, columnKey: null };

    expect(
      reconcile(pages, [withoutColumn], DATABASE).discrepancies.map(
        (d) => d.kind,
      ),
    ).toEqual(["status-mismatch"]);
  });

  it("matches tasks by key when they carry no source reference", () => {
    const pages = [page("a", "Open", "Bug")];
    const [task] = imported(pages);
    if (!task) throw new Error("expected a task");
    const { sourceRef: _sourceRef, ...withoutRef } = task;

    expect(reconcile(pages, [withoutRef], DATABASE).discrepancies).toEqual([]);
  });
});

describe("idempotency keys", () => {
  it("gives a page the same key on every import and reads the page id back", () => {
    const first = imported([page("a", "Open", "Bug")])[0]?.key;
    const again = imported([page("a", "Fixed", "Bug")])[0]?.key;

    expect(first).toBe(notionIdempotencyKey("hr", "a"));
    expect(again).toBe(first);
    expect(pageIdFromKey("hr:notion:a")).toBe("a");
    expect(pageIdFromKey("hr:linear:a")).toBeUndefined();
  });
});
