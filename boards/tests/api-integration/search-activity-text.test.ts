import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { getActivitySearchContent } from "../../apps/api/src/search/controllers/activity-content";
import { searchableActivityText } from "../../apps/api/src/search/controllers/activity-search-text";
import { wordConditions } from "../../apps/api/src/search/query-words";
import { resetTestDatabase } from "./helpers/database";
import { createProjectFixture } from "./helpers/fixtures";
import { createForest } from "./helpers/forest";

// TB-197: global search shows an activity with no text of its own as its
// rendered event, so each word of that text must pass the SQL filter.
// Values with quotes, a backslash, `_`, `-`, Cyrillic and a number: the
// stored JSON escapes or holds them differently from the shown text.
const EVENTS: { type: string; eventData: unknown; content?: string }[] = [
  {
    type: "status_changed",
    eventData: { oldStatus: "to-do", newStatus: "in_progress" },
  },
  {
    type: "priority_changed",
    eventData: { oldPriority: "no-priority", newPriority: "urgent" },
  },
  { type: "unassigned", eventData: {} },
  { type: "assignee_changed", eventData: { isSelfAssigned: true } },
  { type: "assignee_changed", eventData: { newAssignee: "Ада Л." } },
  { type: "assignee_changed", eventData: { newAssignee: null } },
  { type: "due_date_changed", eventData: { newDueDate: null } },
  { type: "due_date_changed", eventData: { newDueDate: "2026-12-01" } },
  {
    type: "due_date_changed",
    eventData: { oldDueDate: "2026-11-01", newDueDate: "2026-12-01" },
  },
  {
    type: "title_changed",
    eventData: { oldTitle: 'Say "hi"', newTitle: "C:\\path\\x_y" },
  },
  { type: "title_changed", eventData: { oldTitle: 7, newTitle: "Счёт" } },
  { type: "task", eventData: { title: "x" } },
  { type: "comment", eventData: null, content: "plain words here" },
  { type: "status_changed", eventData: { newStatus: "done" }, content: "" },
];

describe("API integration: global search matches the shown activity text (TB-197)", () => {
  beforeEach(resetTestDatabase);

  it("every word of every rendered event passes the SQL filter", async () => {
    const forest = await createForest();
    const { project } = await createProjectFixture({
      workspaceId: forest.workspace.id,
      slug: "ACT",
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Activity host",
        status: "to-do",
        number: 1,
        userId: forest.ownerId,
      })
      .returning();
    if (!task) throw new Error("fixture");

    const missed: string[] = [];
    let checked = 0;
    for (const event of EVENTS) {
      const [row] = await db
        .insert(schema.activityTable)
        .values({
          taskId: task.id,
          type: event.type,
          userId: forest.ownerId,
          content: event.content ?? null,
          eventData: event.eventData,
        })
        .returning();
      if (!row) throw new Error("fixture");
      const shown = getActivitySearchContent(
        row.type,
        row.content,
        row.eventData,
      );
      expect(shown, event.type).toBeTruthy();
      for (const word of new Set((shown ?? "").split(/\s+/).filter(Boolean))) {
        const match = wordConditions([word.toLowerCase()]);
        const found = await db
          .select({ id: schema.activityTable.id })
          .from(schema.activityTable)
          .where(
            and(
              eq(schema.activityTable.id, row.id),
              match.inAnyField([searchableActivityText]),
            ),
          );
        checked += 1;
        if (found.length !== 1) missed.push(`${event.type}: ${word}`);
      }
    }
    expect(missed).toEqual([]);
    expect(checked).toBeGreaterThan(50);
  });
});
