import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const NOTION_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

// TB-91: sessions looked a mirrored card up page by page with list_tasks and
// card meta; one search by the Notion id or link now finds it.
describe("search by Notion page id", () => {
  beforeEach(resetTestDatabase);

  it("finds the mirrored card by its id or link, only in its workspace", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
      slug: "DEP",
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({ projectId: project.id, title: "Mirrored", number: 7 })
      .returning({ id: schema.taskTable.id });
    if (!task) throw new Error("task");
    await db.insert(schema.cardMetaTable).values({
      taskId: task.id,
      workspaceId: member.workspace.id,
      notionPageId: NOTION_ID,
      updatedBy: "test",
    });
    await db
      .insert(schema.taskTable)
      .values({ projectId: project.id, title: "Other", number: 8 });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const search = async (q: string, workspaceId = member.workspace.id) => {
      const response = await app.request(
        `/api/search?${new URLSearchParams({ q, workspaceId, type: "tasks" })}`,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        results: { id: string; relevanceScore: number }[];
      };
    };

    const bare = NOTION_ID.replaceAll("-", "");
    for (const q of [
      NOTION_ID,
      bare,
      bare.toUpperCase(),
      `https://www.notion.so/team/Mirrored-${bare}?pvs=4`,
    ]) {
      const { results } = await search(q);
      expect(results).toEqual([
        expect.objectContaining({ id: task.id, relevanceScore: 10 }),
      ]);
    }
    expect((await search("DEP-7")).results[0]?.id).toBe(task.id);

    const stranger = await createWorkspaceMember();
    mockAuthenticatedSession(stranger.user);
    expect((await search(NOTION_ID, stranger.workspace.id)).results).toEqual(
      [],
    );
  });
});
