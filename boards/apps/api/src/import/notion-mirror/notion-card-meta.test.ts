import type { ImportedTask } from "@kaneo/importers";
import { describe, expect, it } from "vite-plus/test";
import { notionCardMeta } from "./notion-card-meta";

function task(
  extraFields: ImportedTask["extraFields"],
  lastEditedTime = "2026-10-02T10:00:00.000Z",
  more: Partial<ImportedTask> = {},
): ImportedTask {
  return {
    key: "hr:notion:p-1",
    columnKey: null,
    title: "Task",
    description: "",
    priority: "no-priority",
    labelKeys: [],
    comments: [],
    sourceRef: { system: "notion", pageId: "p-1", lastEditedTime },
    ...(extraFields ? { extraFields } : {}),
    ...more,
  };
}

describe("notionCardMeta", () => {
  it("reads the card fields from the page's source fields", () => {
    expect(
      notionCardMeta(
        task(
          {
            "Half-baked idea": true,
            Report: "Seen on staging",
            Severity: "High",
            Type: "Ошибка",
            Status: "In progress",
            Owner: "Ana",
          },
          undefined,
          { footer: { "Task ID": "T-1", "Backlog ID": "B-12" } },
        ),
      ),
    ).toEqual({
      kind: "bug",
      severity: "High",
      backlogId: "B-12",
      halfBaked: true,
      report: "Seen on staging",
      notionPageId: "p-1",
      notionStatus: "In progress",
      notionEditedAt: new Date("2026-10-02T10:00:00.000Z"),
    });
  });

  it("falls back to the defaults for a page without those fields", () => {
    expect(notionCardMeta(task(undefined, "not a date"))).toMatchObject({
      kind: "task",
      severity: null,
      backlogId: null,
      halfBaked: false,
      notionEditedAt: null,
    });
  });

  it("keeps the Backlog ID raw, spaces included, and drops it when told", () => {
    const padded = task({}, undefined, {
      footer: { "Backlog ID": " FIX-07 " },
    });
    expect(notionCardMeta(padded)?.backlogId).toBe(" FIX-07 ");
    expect(notionCardMeta(padded, false)?.backlogId).toBeNull();
  });

  it("never reads the Backlog ID from the body", () => {
    const edited = task({ "Backlog ID": "FIX-07" }, undefined, {
      description: 'Text\n\nNotion: {"Backlog ID":"FIX-99"}',
    });
    expect(notionCardMeta(edited)?.backlogId).toBeNull();
  });

  it("takes the kind from the database when the page has no Type", () => {
    const bug = task({}, undefined, {
      sourceRef: {
        system: "notion",
        pageId: "p-1",
        lastEditedTime: "2026-10-02T10:00:00.000Z",
        database: "Ошибки",
      },
    });
    expect(notionCardMeta(bug)?.kind).toBe("bug");
    expect(notionCardMeta(task({ Type: "Feature" }))?.kind).toBe("task");
  });

  it("skips tasks that did not come from Notion", () => {
    const { sourceRef: _ref, ...plain } = task({});
    expect(notionCardMeta(plain)).toBeNull();
  });
});
