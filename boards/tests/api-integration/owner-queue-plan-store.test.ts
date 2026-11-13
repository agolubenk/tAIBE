import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  cardMetaTable,
  taskLeaseTable,
} from "../../apps/api/src/database/forest-schema";
import { planStore } from "../../apps/api/src/forest/owner-queue/plan-store";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function board() {
  const { workspace } = await createWorkspaceMember({ role: "owner" });
  const { project } = await createProjectFixture({
    workspaceId: workspace.id,
    slug: "TB",
  });
  return { workspace, project };
}

async function card(
  projectId: string,
  number: number,
  status: string,
  extra: { updatedAt?: Date; completedAt?: Date } = {},
) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({ projectId, title: `Card ${number}`, status, number, ...extra })
    .returning();
  return task;
}

async function lease(taskId: string, expiresAt: Date) {
  await db.insert(taskLeaseTable).values({
    taskId,
    holderId: "session-1",
    holderName: "agent",
    holderKind: "agent",
    expiresAt,
  });
}

describe("API integration: owner-queue plan store (TB-106)", () => {
  beforeEach(resetTestDatabase);

  it("resolves row cards in mapped workspaces only, any key case", async () => {
    const mine = await board();
    const other = await board();
    const now = new Date();
    await card(mine.project.id, 1, "in-review");
    await card(mine.project.id, 2, "done", {
      completedAt: new Date(now.getTime() - 3 * DAY),
    });
    await card(mine.project.id, 3, "archived");
    await card(other.project.id, 1, "done");

    const found = await planStore.resolve(
      [mine.workspace.id],
      [
        { ws: mine.workspace.slug, key: "TB-1" },
        { ws: mine.workspace.slug, key: "tb-2" },
        { ws: mine.workspace.slug, key: "TB-3" },
        { ws: mine.workspace.slug, key: "TB-404" },
        { ws: other.workspace.slug, key: "TB-1" },
      ],
    );

    expect([...found.keys()].sort()).toEqual(
      [1, 2, 3].map((n) => `${mine.workspace.slug}/TB-${n}`),
    );
    expect(found.get(`${mine.workspace.slug}/TB-1`)).toEqual({
      status: "in-review",
      final: false,
      closedAt: null,
    });
    expect(found.get(`${mine.workspace.slug}/TB-2`)).toMatchObject({
      status: "done",
      final: true,
    });
    expect(found.get(`${mine.workspace.slug}/TB-3`)?.final).toBe(true);
  });

  it("lists cards that moved in 14 days for the off-plan row (F8)", async () => {
    const mine = await board();
    const other = await board();
    const now = new Date();
    const bug = await card(mine.project.id, 1, "in-review");
    await db.insert(cardMetaTable).values({
      taskId: bug.id,
      workspaceId: mine.workspace.id,
      kind: "bug",
      severity: "high",
    });
    await card(mine.project.id, 2, "done", {
      completedAt: new Date(now.getTime() - 2 * DAY),
    });
    await card(mine.project.id, 3, "done", {
      completedAt: new Date(now.getTime() - 20 * DAY),
    });
    await card(mine.project.id, 4, "to-do");
    await card(mine.project.id, 5, "in-progress", {
      updatedAt: new Date(now.getTime() - 20 * DAY),
    });
    await card(other.project.id, 6, "in-progress");

    const recent = await planStore.recent(
      new Map([[mine.workspace.id, "taibe"]]),
      new Date(now.getTime() - 14 * DAY),
    );

    expect(recent.map((c) => c.key).sort()).toEqual(["TB-1", "TB-2"]);
    expect(recent.find((c) => c.key === "TB-1")).toMatchObject({
      ws: mine.workspace.slug,
      product: "taibe",
      title: "Card 1",
      bug: true,
      level: "high",
      status: "in-review",
      final: false,
    });
    expect(recent.find((c) => c.key === "TB-2")).toMatchObject({
      bug: false,
      final: true,
    });
  });

  it("finds in-progress cards without a live lease and without updates for 24 h (F9)", async () => {
    const mine = await board();
    const now = new Date();
    const stale = new Date(now.getTime() - 30 * HOUR);
    await card(mine.project.id, 1, "in-progress", { updatedAt: stale });
    const leased = await card(mine.project.id, 2, "in-progress", {
      updatedAt: stale,
    });
    await lease(leased.id, new Date(now.getTime() + HOUR));
    const lapsed = await card(mine.project.id, 3, "in-progress", {
      updatedAt: stale,
    });
    await lease(lapsed.id, new Date(now.getTime() - HOUR));
    await card(mine.project.id, 4, "in-progress", {
      updatedAt: new Date(now.getTime() - HOUR),
    });
    await card(mine.project.id, 5, "in-review", { updatedAt: stale });

    const abandoned = await planStore.abandoned([mine.workspace.id], now);

    expect([...abandoned].sort()).toEqual(
      [1, 3].map((n) => `${mine.workspace.slug}/TB-${n}`),
    );
  });
});
