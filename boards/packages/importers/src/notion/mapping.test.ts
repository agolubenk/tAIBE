import { describe, expect, it } from "vite-plus/test";
import type {
  NotionDatabase,
  NotionPage,
  NotionPropertyValue,
} from "./api-types.js";
import {
  mapColumns,
  mapDatabase,
  mapPage,
  mapPriorityName,
} from "./mapping.js";

const STATUS_SCHEMA = {
  id: "st",
  name: "Status",
  type: "status",
  status: {
    options: [
      { id: "o1", name: "Backlog" },
      { id: "o2", name: "In progress" },
      { id: "o3", name: "Done" },
      { id: "o4", name: "Won't do" },
    ],
    groups: [
      { name: "To-do", option_ids: ["o1"] },
      { name: "In progress", option_ids: ["o2"] },
      { name: "Complete", option_ids: ["o3", "o4"] },
    ],
  },
};

function database(overrides: Partial<NotionDatabase> = {}): NotionDatabase {
  return {
    id: "db-1",
    title: [{ plain_text: "Tasks" }],
    properties: {
      Status: STATUS_SCHEMA,
      Name: { id: "t", name: "Name", type: "title" },
    },
    ...overrides,
  };
}

function prop(
  type: string,
  value: Omit<NotionPropertyValue, "id" | "type">,
): NotionPropertyValue {
  return { id: type, type, ...value };
}

function page(
  id: string,
  properties: Record<string, NotionPropertyValue> = {},
  overrides: Partial<NotionPage> = {},
): NotionPage {
  return {
    object: "page",
    id,
    archived: false,
    created_time: "2026-10-01T09:00:00.000Z",
    last_edited_time: "2026-10-02T10:00:00.000Z",
    properties: {
      Name: prop("title", { title: [{ plain_text: `Task ${id}` }] }),
      ...properties,
    },
    ...overrides,
  };
}

const status = (name: string) => prop("status", { status: { name } });
const select = (name: string) => prop("select", { select: { name } });

const CONTEXT = {
  product: "hr",
  columnKeyByStatus: mapColumns(database()).columnKeyByStatus,
  description: "",
};

describe("mapColumns", () => {
  it("keeps the status order and marks the Complete group final", () => {
    expect(mapColumns(database()).columns).toEqual([
      { key: "backlog", name: "Backlog", isFinal: false },
      { key: "in-progress", name: "In progress", isFinal: false },
      { key: "done", name: "Done", isFinal: true },
      { key: "won-t-do", name: "Won't do", isFinal: true },
    ]);
  });

  it("falls back to final-looking names when a select has no groups", () => {
    const columns = mapColumns(
      database({
        properties: {
          Status: {
            id: "st",
            name: "Status",
            type: "select",
            select: { options: [{ name: "Новая" }, { name: "Готово" }] },
          },
        },
      }),
    ).columns;
    expect(columns.map((column) => column.isFinal)).toEqual([false, true]);
  });
});

describe("mapPriorityName", () => {
  it("reads names and P-levels, and leaves the rest without priority", () => {
    expect(mapPriorityName("P0")).toBe("urgent");
    expect(mapPriorityName("Высокий")).toBe("high");
    expect(mapPriorityName("p2")).toBe("medium");
    expect(mapPriorityName("Low")).toBe("low");
    expect(mapPriorityName("Someday")).toBe("no-priority");
    expect(mapPriorityName(undefined)).toBe("no-priority");
  });
});

describe("mapPage", () => {
  it("maps status, priority, number, due date, labels and the source reference", () => {
    const { task, labels } = mapPage(
      page("p-1", {
        Status: status("In progress"),
        Priority: select("P1"),
        ID: prop("unique_id", { unique_id: { prefix: "T", number: 42 } }),
        Due: prop("date", { date: { start: "2026-11-05" } }),
        Tags: prop("multi_select", {
          multi_select: [{ id: "l1", name: "backend", color: "blue" }],
        }),
      }),
      CONTEXT,
    );

    expect(task).toMatchObject({
      key: "hr:notion:p-1",
      number: 42,
      columnKey: "in-progress",
      title: "Task p-1",
      priority: "high",
      dueDate: "2026-11-05T00:00:00.000Z",
      labelKeys: ["l1"],
      sourceRef: {
        system: "notion",
        pageId: "p-1",
        lastEditedTime: "2026-10-02T10:00:00.000Z",
      },
    });
    expect(task.archived).toBeUndefined();
    expect(labels).toEqual([{ key: "l1", name: "backend", color: "#3b82f6" }]);
  });

  it("never takes severity for a missing priority", () => {
    const { task } = mapPage(
      page("p-2", { Severity: select("Critical") }),
      CONTEXT,
    );
    expect(task.priority).toBe("no-priority");
    expect(task.extraFields).toEqual({ Severity: "Critical" });
  });

  it("labels the values of select fields without a place of their own", () => {
    const { task, labels } = mapPage(
      page("p-4", {
        "Task Type": prop("select", {
          select: { id: "tt1", name: "feature", color: "green" },
        }),
        Source: prop("select", { select: { id: "s1", name: "BACKLOG.md" } }),
        Priority: select("P2"),
      }),
      { ...CONTEXT, labelSelects: new Set(["Task Type", "Source"]) },
    );
    expect(labels).toEqual([
      { key: "Task Type:tt1", name: "Task Type: feature", color: "#22c55e" },
      { key: "Source:s1", name: "Source: BACKLOG.md", color: "#6b7280" },
    ]);
    expect(task.labelKeys).toEqual(["Task Type:tt1", "Source:s1"]);
    expect(task.priority).toBe("medium");
  });

  it("holds back a footer value that looks personal and names its field", () => {
    const { task } = mapPage(
      page("p-6", {
        "Task ID": prop("rich_text", { rich_text: [{ plain_text: "T-3" }] }),
        Очередь: prop("rich_text", {
          rich_text: [{ plain_text: "ask ann@example.com" }],
        }),
      }),
      { ...CONTEXT, footerFields: ["Task ID", "Очередь"] },
    );
    expect(task.footer).toEqual({ "Task ID": "T-3" });
    expect(task.losses).toEqual([{ field: "Очередь", reason: "personal" }]);
  });

  it("keeps a link's text and reports its address as lost", () => {
    const { task } = mapPage(
      page("p-7", {
        "Backlog ID": prop("rich_text", {
          rich_text: [{ plain_text: "FIX-07", href: "/a1b2c3" }],
        }),
      }),
      { ...CONTEXT, footerFields: ["Backlog ID"] },
    );
    expect(task.footer).toEqual({ "Backlog ID": "FIX-07" });
    expect(task.losses).toEqual([{ field: "Backlog ID", reason: "link" }]);
  });

  it("keeps Report links as markdown and reports a linked title", () => {
    const { task } = mapPage(
      page("p-8", {
        Name: prop("title", {
          title: [
            { plain_text: "Fix ", href: null },
            { plain_text: "login", href: "/a1" },
          ],
        }),
        Report: prop("rich_text", {
          rich_text: [
            { plain_text: "done in " },
            { plain_text: "PR [1]", href: "https://github.com/x/pull/1" },
            {
              plain_text: ", log",
              href: "https://prod-files-secure.s3.amazonaws.com/l",
            },
          ],
        }),
      }),
      CONTEXT,
    );
    expect(task.title).toBe("Fix login");
    expect(task.extraFields?.Report).toBe(
      "done in [PR \\[1\\]](https://github.com/x/pull/1), log",
    );
    expect(task.losses).toEqual([
      { field: "Name", reason: "link" },
      { field: "Report", reason: "signed" },
    ]);
  });

  it("keeps footer fields raw and in the given order, leaving empty ones out", () => {
    const { task } = mapPage(
      page("p-5", {
        "Council readiness": prop("number", { number: 0.72 }),
        "Task ID": prop("rich_text", { rich_text: [{ plain_text: " T-12" }] }),
        "Bug ID": prop("rich_text", { rich_text: [] }),
        Очередь: prop("rich_text", {
          rich_text: [{ plain_text: "w-n-ats-all · ATS" }],
        }),
      }),
      {
        ...CONTEXT,
        database: "Задачи",
        footerFields: ["Task ID", "Bug ID", "Очередь", "Council readiness"],
      },
    );
    expect(task.footer).toEqual({
      "Task ID": " T-12",
      Очередь: "w-n-ats-all · ATS",
      "Council readiness": 0.72,
    });
    expect(Object.keys(task.footer ?? {})).toEqual([
      "Task ID",
      "Очередь",
      "Council readiness",
    ]);
    expect(task.sourceRef).toMatchObject({
      createdTime: "2026-10-01T09:00:00.000Z",
      database: "Задачи",
    });
  });

  it("archives trashed and archived pages with the reason", () => {
    const trashed = mapPage(page("p-3", {}, { in_trash: true }), CONTEXT).task;
    const archived = mapPage(page("p-4", {}, { archived: true }), CONTEXT).task;
    expect(trashed).toMatchObject({
      archived: true,
      terminalReason: "Page is in the Notion trash",
    });
    expect(archived).toMatchObject({
      archived: true,
      terminalReason: "Page is archived in Notion",
    });
  });

  it("keeps source fields verbatim, people by name only", () => {
    const { task } = mapPage(
      page("p-5", {
        "Backlog ID": prop("unique_id", {
          unique_id: { prefix: "B", number: 12 },
        }),
        "Half-baked idea": prop("checkbox", { checkbox: true }),
        Report: prop("rich_text", {
          rich_text: [{ plain_text: " Seen on staging " }],
        }),
        Type: select("Bug"),
        Reviewer: prop("people", {
          people: [
            { name: "Ana Example", person: { email: "ana@example.test" } },
          ],
        }),
      }),
      CONTEXT,
    );

    expect(task.extraFields).toEqual({
      "Backlog ID": "B-12",
      "Half-baked idea": true,
      Report: "Seen on staging",
      Type: "Bug",
      Reviewer: "Ana Example",
    });
    expect(JSON.stringify(task.extraFields)).not.toContain("@");
  });

  it("leaves a page without a known status out of every column", () => {
    const { task } = mapPage(page("p-6", { Status: status("Gone") }), CONTEXT);
    expect(task.columnKey).toBeNull();
  });
});

describe("mapDatabase", () => {
  it("stores an edge listed from both ends once", () => {
    const parent = page("parent", {
      "Sub-items": prop("relation", { relation: [{ id: "child" }] }),
      "Related to": prop("relation", { relation: [{ id: "other" }] }),
    });
    const child = page("child", {
      "Parent item": prop("relation", { relation: [{ id: "parent" }] }),
    });
    const other = page("other", {
      "Related to": prop("relation", { relation: [{ id: "parent" }] }),
    });

    const project = mapDatabase(
      database(),
      [parent, child, other],
      new Map(),
      "hr",
    );

    expect(project.relations).toEqual([
      {
        sourceKey: "hr:notion:parent",
        targetKey: "hr:notion:child",
        type: "subtask",
      },
      {
        sourceKey: "hr:notion:parent",
        targetKey: "hr:notion:other",
        type: "related",
      },
    ]);
  });

  it("reads Sub-bugs as subtasks", () => {
    const project = mapDatabase(
      database(),
      [
        page("bug", {
          "Sub-bugs": prop("relation", { relation: [{ id: "b2" }] }),
        }),
      ],
      new Map(),
      "hr",
    );
    expect(project.relations).toEqual([
      {
        sourceKey: "hr:notion:bug",
        targetKey: "hr:notion:b2",
        type: "subtask",
      },
    ]);
  });

  it("names every label the schema defines and picks the footer fields", () => {
    const project = mapDatabase(
      database({
        properties: {
          Status: STATUS_SCHEMA,
          Name: { id: "t", name: "Name", type: "title" },
          Priority: {
            id: "p",
            name: "Priority",
            type: "select",
            select: { options: [{ id: "p0", name: "P0" }] },
          },
          Est: {
            id: "e",
            name: "Est",
            type: "select",
            select: {
              options: [
                { id: "e1", name: "S" },
                { id: "e2", name: "M" },
              ],
            },
          },
          Tags: {
            id: "g",
            name: "Tags",
            type: "multi_select",
            multi_select: { options: [{ id: "g1", name: "spike" }] },
          },
          "Bug ID": { id: "b", name: "Bug ID", type: "rich_text" },
        },
      }),
      [
        page("p-8", {
          Est: prop("select", { select: { id: "e2", name: "M" } }),
          "Bug ID": prop("rich_text", { rich_text: [{ plain_text: "B-3" }] }),
        }),
      ],
      new Map(),
      "hr",
      { footerFields: /^(task id|bug id)$/i },
    );
    expect(project.labelNames).toEqual(["Est: S", "Est: M", "spike"]);
    expect(project.labels.map(({ name }) => name)).toEqual(["Est: M"]);
    expect(project.tasks[0]?.footer).toEqual({ "Bug ID": "B-3" });
    expect(project.tasks[0]?.sourceRef?.database).toBe("Tasks");
  });

  it("takes page bodies and warns when the database has no status", () => {
    const project = mapDatabase(
      database({ properties: {} }),
      [page("p-7")],
      new Map([["p-7", "Body text"]]),
      "hr",
    );
    expect(project.name).toBe("Tasks");
    expect(project.columns).toEqual([]);
    expect(project.tasks[0]?.description).toBe("Body text");
    expect(project.warnings).toHaveLength(1);
  });
});
