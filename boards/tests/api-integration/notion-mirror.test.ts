import type { ImportedProject, ImportedTask } from "@kaneo/importers";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  cardHistoryTable,
  cardMetaTable,
} from "../../apps/api/src/database/forest-schema";
import { writeImportedProject } from "../../apps/api/src/import/write-imported-project";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

const T1 = "2026-10-01T10:00:00.000Z";
const T2 = "2026-10-05T10:00:00.000Z";

function page(
  id: string,
  edited: string,
  overrides: Partial<ImportedTask> = {},
  fields: ImportedTask["extraFields"] = {},
): ImportedTask {
  return {
    key: `hr:notion:${id}`,
    columnKey: "open",
    title: `Page ${id}`,
    description: `Body ${id}`,
    priority: "medium",
    labelKeys: [],
    comments: [],
    sourceRef: { system: "notion", pageId: id, lastEditedTime: edited },
    extraFields: { Type: "Task", Status: "Open", ...fields },
    ...overrides,
  };
}

function database(tasks: ImportedTask[]): ImportedProject {
  return {
    name: "Bugs",
    columns: [
      { key: "open", name: "Open", isFinal: false },
      { key: "fixed", name: "Fixed", isFinal: true },
    ],
    labels: [],
    tasks,
    relations: [],
    warnings: [],
  };
}

async function importNotion(
  workspaceId: string,
  userId: string,
  tasks: ImportedTask[],
) {
  return writeImportedProject({
    workspaceId,
    userId,
    source: "notion",
    project: database(tasks),
    includeComments: false,
  });
}

async function cards(projectId: string) {
  return db
    .select({
      id: schema.taskTable.id,
      title: schema.taskTable.title,
      status: schema.taskTable.status,
      number: schema.taskTable.number,
      pageId: cardMetaTable.notionPageId,
      kind: cardMetaTable.kind,
      backlogId: cardMetaTable.backlogId,
      notionStatus: cardMetaTable.notionStatus,
      editedAt: cardMetaTable.notionEditedAt,
      executor: cardMetaTable.executor,
    })
    .from(schema.taskTable)
    .leftJoin(cardMetaTable, eq(cardMetaTable.taskId, schema.taskTable.id))
    .where(eq(schema.taskTable.projectId, projectId))
    .orderBy(schema.taskTable.number);
}

describe("API integration: Notion mirror re-import (R-080)", () => {
  beforeEach(resetTestDatabase);

  it("rewrites edited pages, skips the rest, adds new ones, keeps agent fields", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const first = await importNotion(workspace.id, user.id, [
      page(
        "a",
        T1,
        { number: 7, footer: { "Backlog ID": "B-1" } },
        { Type: "Bug" },
      ),
      page("b", T1),
    ]);
    expect(first.warnings).not.toContain(
      expect.stringMatching(/Notion mirror/),
    );

    const before = await cards(first.projectId);
    expect(
      before.map(({ pageId, kind, backlogId, number }) => ({
        pageId,
        kind,
        backlogId,
        number,
      })),
    ).toEqual([
      { pageId: "a", kind: "bug", backlogId: "B-1", number: 7 },
      { pageId: "b", kind: "task", backlogId: null, number: 8 },
    ]);
    const cardA = before[0]?.id ?? "";
    const cardB = before[1]?.id ?? "";
    // An agent's field on the card must survive the next import.
    await db
      .update(cardMetaTable)
      .set({ executor: "dev-1" })
      .where(eq(cardMetaTable.taskId, cardA));

    const second = await importNotion(workspace.id, user.id, [
      page(
        "a",
        T2,
        {
          title: "Page a, fixed",
          columnKey: "fixed",
          number: 7,
          footer: { "Backlog ID": "B-1" },
        },
        { Type: "Bug", Status: "Fixed" },
      ),
      page("b", T1, { title: "Ignored: Notion did not edit it" }),
      page("c", T2, { number: 7 }),
    ]);

    expect(second.projectId).toBe(first.projectId);
    expect(second.warnings[0]).toBe(
      "Notion mirror: 1 new, 1 updated, 1 unchanged, 1 with changed meta.",
    );
    expect(second.counts.tasks).toBe(2);

    const after = await cards(first.projectId);
    expect(
      after.map(({ id, title, status, notionStatus, executor }) => ({
        id,
        title,
        status,
        notionStatus,
        executor,
      })),
    ).toEqual([
      {
        id: cardA,
        title: "Page a, fixed",
        status: "fixed",
        notionStatus: "Fixed",
        executor: "dev-1",
      },
      {
        id: cardB,
        title: "Page b",
        status: "open",
        notionStatus: "Open",
        executor: null,
      },
      {
        id: expect.any(String),
        title: "Page c",
        status: "open",
        notionStatus: "Open",
        executor: null,
      },
    ]);
    // Number 7 is taken by page a, so page c continues after the last one.
    expect(after[2]?.number).toBe(9);
    expect(after[0]?.editedAt?.toISOString()).toBe(T2);

    const history = await db
      .select({ taskId: cardHistoryTable.taskId, kind: cardHistoryTable.kind })
      .from(cardHistoryTable)
      .where(inArray(cardHistoryTable.taskId, [cardA, cardB]));
    expect(history.filter(({ taskId }) => taskId === cardA)).toEqual(
      expect.arrayContaining([
        { taskId: cardA, kind: "meta" },
        { taskId: cardA, kind: "task" },
      ]),
    );
    expect(history.filter(({ taskId }) => taskId === cardB)).toEqual([
      { taskId: cardB, kind: "meta" },
    ]);
  });

  it("refuses pages another workspace already mirrors", async () => {
    const one = await createWorkspaceMember({ role: "owner" });
    const two = await createWorkspaceMember({ role: "owner" });
    await importNotion(one.workspace.id, one.user.id, [page("a", T1)]);

    await expect(
      importNotion(two.workspace.id, two.user.id, [page("a", T2)]),
    ).rejects.toThrow(/already mirror into another workspace/);
  });

  it("drops a Backlog ID a card outside the import already holds", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const B1 = { footer: { "Backlog ID": "B-1" } };
    const first = await importNotion(workspace.id, user.id, [
      page("a", T1, B1),
    ]);

    const again = await importNotion(workspace.id, user.id, [
      page("a", T1, B1),
      page("z", T1, B1),
    ]);

    expect(again.warnings).toContain(
      "Kept a Backlog ID another card holds in the footer of 1 card: B-1.",
    );
    const [held, footer] = await cards(first.projectId);
    expect([held?.backlogId, footer?.backlogId]).toEqual(["B-1", null]);
    const [body] = await db
      .select({ description: schema.taskTable.description })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, footer?.id ?? ""));
    expect(body?.description).toBe('Body z\n\nNotion: {"Backlog ID":"B-1"}');
  });

  it("leaves each Backlog ID with its holder on every normal pass", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const holding = (id: string, createdTime: string) =>
      page(id, T1, {
        footer: { "Backlog ID": "B-1" },
        sourceRef: {
          system: "notion",
          pageId: id,
          lastEditedTime: T1,
          createdTime,
        },
      });
    // Page z came first into the mirror, page a is older in Notion.
    const first = await importNotion(workspace.id, user.id, [holding("z", T2)]);
    const pages = [holding("a", T1), holding("z", T2)];
    const second = await importNotion(workspace.id, user.id, pages);
    const third = await importNotion(workspace.id, user.id, pages);

    const holders = async () =>
      (await cards(first.projectId)).map(({ pageId, backlogId }) => ({
        pageId,
        backlogId,
      }));
    expect(await holders()).toEqual([
      { pageId: "z", backlogId: "B-1" },
      { pageId: "a", backlogId: null },
    ]);
    expect(third.warnings).toEqual([
      "Notion mirror: 0 new, 0 updated, 2 unchanged, 0 with changed meta.",
      ...second.warnings.slice(1),
    ]);
    expect(second.warnings).toContain(
      "Backlog ID B-1: held by page z; in the footer: a.",
    );
  });
});
