import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

type Forest = Awaited<ReturnType<typeof createForest>>;
type FeedItem = { content: string | null; eventData: unknown };

async function comment(
  forest: Forest,
  taskId: string,
  content: string,
  session: string,
  groupKey?: string,
) {
  const res = await forest.agentApi(
    "POST",
    `/comment/${taskId}`,
    { content },
    groupKey ? { "x-t-boards-group": groupKey } : {},
    session,
  );
  expect(res.status).toBe(200);
  return res.body as FeedItem;
}

async function feed(forest: Forest, taskId: string) {
  const res = await forest.ownerApi("GET", `/activity/${taskId}`);
  expect(res.status).toBe(200);
  const items = res.body as FeedItem[];
  return new Map(items.map((item) => [item.content, item.eventData]));
}

// R-026, AC-010: linked sessions talk on the card; the talk is archived and
// stays readable.
describe("API integration: dialog of linked sessions", () => {
  beforeEach(resetTestDatabase);

  it("marks the comments of a lease group and archives them when the lease ends", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id);
    const writer = await forest.agent(
      "/leases",
      { taskId: task.id, groupKey: "pair-1" },
      "writer",
    );
    expect(writer.status).toBe(200);
    const reviewer = await forest.agent(
      "/leases",
      { taskId: task.id, groupKey: "pair-1" },
      "reviewer",
    );
    expect(reviewer.body.fencingToken).toBe(writer.body.fencingToken);

    const episode = {
      groupKey: "pair-1",
      fencingToken: writer.body.fencingToken,
    };
    const byWriter = { ...episode, session: "writer" };
    const byReviewer = { ...episode, session: "reviewer" };
    expect(
      (await comment(forest, task.id, "writer: plan", "writer")).eventData,
    ).toEqual({ dialog: byWriter });
    expect(
      (await comment(forest, task.id, "reviewer: ok", "reviewer", "pair-1"))
        .eventData,
    ).toEqual({ dialog: byReviewer });
    expect(
      (await comment(forest, task.id, "rival: note", "rival")).eventData,
    ).toBeNull();
    const owner = await forest.ownerApi("POST", `/comment/${task.id}`, {
      content: "owner: fine",
    });
    expect(owner.body.eventData).toBeNull();

    const open = await feed(forest, task.id);
    expect(open.get("writer: plan")).toEqual({
      dialog: { ...byWriter, open: true },
    });
    expect(open.get("reviewer: ok")).toEqual({
      dialog: { ...byReviewer, open: true },
    });
    expect(open.get("rival: note")).toBeNull();

    const released = await forest.agent(
      "/leases/release",
      { taskId: task.id, fencingToken: writer.body.fencingToken },
      "writer",
    );
    expect(released.body).toEqual({ released: true });
    const archived = await feed(forest, task.id);
    expect(archived.get("writer: plan")).toEqual({
      dialog: { ...byWriter, open: false },
    });
  });

  it("archives the dialog when the card goes to review, the lease still live", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id);
    const lease = await forest.agent(
      "/leases",
      { taskId: task.id, groupKey: "pair-2" },
      "writer",
    );
    await comment(forest, task.id, "writer: done", "writer");
    await db
      .update(schema.taskTable)
      .set({ status: "in-review" })
      .where(eq(schema.taskTable.id, task.id));

    expect((await feed(forest, task.id)).get("writer: done")).toEqual({
      dialog: {
        groupKey: "pair-2",
        fencingToken: lease.body.fencingToken,
        session: "writer",
        open: false,
      },
    });
  });

  it("does not trust a dialog mark outside a comment", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id);
    const lease = await forest.agent(
      "/leases",
      { taskId: task.id, groupKey: "pair-3" },
      "writer",
    );
    const forged = {
      dialog: {
        groupKey: "pair-3",
        fencingToken: lease.body.fencingToken,
        session: "writer",
      },
    };
    const created = await forest.ownerApi("POST", "/activity/create", {
      taskId: task.id,
      message: "forged",
      type: "note",
      eventData: { ...forged, kept: 1 },
    });
    expect(created.status).toBe(200);
    expect(created.body.eventData).toEqual({ kept: 1 });

    // A row written before the fix: the feed does not add `open` to it.
    await db.insert(schema.activityTable).values({
      taskId: task.id,
      type: "note",
      userId: forest.ownerId,
      content: "old forged",
      eventData: forged,
    });
    const items = await feed(forest, task.id);
    expect(items.get("forged")).toEqual({ kept: 1 });
    expect(items.get("old forged")).toEqual(forged);
  });

  it("marks nothing on a solo lease", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id);
    await forest.agent("/leases", { taskId: task.id }, "solo");
    expect(
      (await comment(forest, task.id, "solo: note", "solo")).eventData,
    ).toBeNull();
  });
});
