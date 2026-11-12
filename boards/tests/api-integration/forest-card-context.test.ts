import { beforeEach, describe, expect, it } from "vite-plus/test";
import { CONTEXT_LIMITS } from "../../apps/api/src/forest/context/context-sections";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest, relate } from "./helpers/forest";

const context = (taskId: string) => `/cards/${taskId}/context`;

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
