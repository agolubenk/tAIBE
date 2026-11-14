import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { CONTEXT_LIMITS } from "../../apps/api/src/forest/context/context-sections";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest, relate } from "./helpers/forest";

const context = (taskId: string) => `/cards/${taskId}/context`;

// A fake token assembled at runtime, so this file holds no key-shaped literal.
const SECRET = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

describe("API integration: card context pack (R-031)", () => {
  beforeEach(resetTestDatabase);

  it("gathers the card, its fields, lease, «да» requests, links, comments and edits in one read", async () => {
    const forest = await createForest();
    const card = await addTask(forest.project.id, "Pack me");
    const blocker = await addTask(forest.project.id, "Blocker");
    if (!card || !blocker) throw new Error("fixture");
    await relate(blocker.id, card.id, "blocks");

    const meta = await forest.owner(`/cards/${card.id}/meta`, undefined);
    expect(meta.status).toBe(200);
    const lease = await forest.agent("/leases", { taskId: card.id }, "dev-1");
    expect(lease.status).toBe(200);
    const asked = await forest.agent("/approvals", {
      action: "close_task",
      targetId: card.id,
      value: "done",
      reason: "finished",
      doneRef: "https://github.com/agolubenk/tAIBE/pull/1",
    });
    expect(asked.status).toBe(200);
    const comment = await forest.ownerApi("POST", `/comment/${card.id}`, {
      content: "First note",
    });
    expect(comment.status).toBe(200);
    const title = await forest.ownerApi("PUT", `/task/title/${card.id}`, {
      title: "Pack me, renamed",
    });
    expect(title.status).toBe(200);

    const res = await forest.owner(context(card.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: card.id,
      title: "Pack me, renamed",
      projectName: forest.project.name,
      labels: [],
      meta: { kind: "task", halfBaked: false },
      lease: { holderKind: "agent" },
      approvals: [
        {
          id: asked.body.id,
          action: "close_task",
          params: { status: "done" },
        },
      ],
      relations: [
        {
          relationType: "blocks",
          direction: "incoming",
          task: { id: blocker.id, title: "Blocker" },
        },
      ],
      comments: [{ content: "First note" }],
      truncated: [],
    });
    expect(res.body.lease).not.toHaveProperty("fencingToken");
    expect(res.body.history[0]).toMatchObject({
      kind: "task",
      fields: expect.arrayContaining(["title"]),
    });
    expect(res.body.history[0]).not.toHaveProperty("changes");
  });

  it("masks secrets in every free-text field of the pack and keeps the stored text (TB-141)", async () => {
    const forest = await createForest();
    const card = await addTask(forest.project.id, `Rotate ${SECRET}`);
    const linked = await addTask(forest.project.id, `Linked ${SECRET}`);
    if (!card || !linked) throw new Error("fixture");
    await relate(card.id, linked.id, "related");
    await db
      .update(schema.taskTable)
      .set({ description: `Description ${SECRET}` })
      .where(eq(schema.taskTable.id, card.id));
    await db.insert(schema.labelTable).values({
      name: `label ${SECRET}`,
      color: "#000000",
      taskId: card.id,
      workspaceId: forest.workspace.id,
    });
    await db.insert(schema.cardMetaTable).values({
      taskId: card.id,
      workspaceId: forest.workspace.id,
      updatedBy: "test",
      report: `report ${SECRET}`,
      executor: `executor ${SECRET}`,
      branch: `fix/${SECRET}`,
      pullRequests: [`https://example.com/pull?ref=${SECRET}`],
      files: [`notes/${SECRET}.md`],
      contextPack: `pack ${SECRET}`,
    });
    const lease = await forest.agent("/leases", { taskId: card.id }, "dev-1");
    expect(lease.status).toBe(200);
    const asked = await forest.agent("/approvals", {
      action: "close_task",
      targetId: card.id,
      value: "done",
      reason: `reason ${SECRET}`,
      doneRef: "https://github.com/agolubenk/tAIBE/pull/1",
    });
    expect(asked.status).toBe(200);
    await db
      .update(schema.ownerApprovalTable)
      .set({ params: { status: "done", note: `param ${SECRET}` } })
      .where(eq(schema.ownerApprovalTable.id, asked.body.id));
    const comment = await forest.ownerApi("POST", `/comment/${card.id}`, {
      content: `comment ${SECRET}`,
    });
    expect(comment.status).toBe(200);

    const res = await forest.owner(context(card.id));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    const masked = expect.stringContaining("[REDACTED:");
    expect(res.body).toMatchObject({
      title: masked,
      description: masked,
      labels: [masked],
      meta: {
        report: masked,
        executor: masked,
        branch: masked,
        pullRequests: [masked],
        files: [masked],
        contextPack: masked,
      },
      approvals: [{ reason: masked, params: { status: "done", note: masked } }],
      relations: [{ task: { id: linked.id, title: masked } }],
      comments: [{ content: masked }],
    });

    // The mask is on the way out only: the stored text does not change.
    const [task] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, card.id));
    const [meta] = await db
      .select()
      .from(schema.cardMetaTable)
      .where(eq(schema.cardMetaTable.taskId, card.id));
    const [note] = await db
      .select({ content: schema.activityTable.content })
      .from(schema.activityTable)
      .where(
        and(
          eq(schema.activityTable.taskId, card.id),
          eq(schema.activityTable.type, "comment"),
        ),
      );
    expect(task?.title).toBe(`Rotate ${SECRET}`);
    expect(task?.description).toBe(`Description ${SECRET}`);
    expect(meta?.contextPack).toBe(`pack ${SECRET}`);
    expect(meta?.files).toEqual([`notes/${SECRET}.md`]);
    expect(note?.content).toBe(`comment ${SECRET}`);
  });

  it("caps long sections and names them in truncated", async () => {
    const forest = await createForest();
    const card = await addTask(forest.project.id, "Busy card");
    if (!card) throw new Error("fixture");
    for (let i = 0; i <= CONTEXT_LIMITS.comments; i++) {
      const res = await forest.ownerApi("POST", `/comment/${card.id}`, {
        content: `note ${i}`,
      });
      expect(res.status).toBe(200);
    }

    const res = await forest.owner(context(card.id));
    expect(res.status).toBe(200);
    expect(res.body.comments).toHaveLength(CONTEXT_LIMITS.comments);
    expect(res.body.comments[0].content).toBe(
      `note ${CONTEXT_LIMITS.comments}`,
    );
    expect(res.body.truncated).toEqual(["comments"]);
  });

  it("keeps another workspace's cards out: 404 by id, hidden as a link", async () => {
    const forest = await createForest();
    const other = await createForest();
    const card = await addTask(forest.project.id, "Mine");
    const foreign = await addTask(other.project.id, "Foreign secret");
    if (!card || !foreign) throw new Error("fixture");
    await relate(card.id, foreign.id, "related");

    const byId = await forest.owner(context(foreign.id));
    expect(byId.status).toBe(404);

    const res = await forest.owner(context(card.id));
    expect(res.status).toBe(200);
    expect(res.body.relations).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("Foreign secret");
  });
});
