import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db from "../../apps/api/src/database";
import { cardMetaTable } from "../../apps/api/src/database/forest-schema";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

// Fake secrets assembled at runtime, so this file holds no key-shaped literal.
const join = (...parts: string[]) => parts.join("");
const SECRET = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const KEY_MARK = "[REDACTED:api_key]";

// The owner writes a secret into a card (title with history, comment, card
// fields); an agent session names the card in its working state and asks
// the owner to close it.
async function setup() {
  const forest = await createForest();
  const ws = forest.workspace.id;
  const task = await addTask(forest.project.id, "Deploy");
  if (!task) throw new Error("fixture");
  const steps = [
    await forest.ownerApi("PUT", `/task/title/${task.id}`, {
      title: `Deploy ${SECRET}`,
    }),
    await forest.ownerApi("POST", `/comment/${task.id}`, {
      content: `note ${SECRET}`,
    }),
    await forest.ownerApi("PUT", `/forest/${ws}/cards/${task.id}/meta`, {
      kind: "bug",
      report: `Report: ${SECRET}`,
      contextPack: `Context: token ${SECRET}\n\nRotate it first.`,
    }),
    await forest.agentApi(
      "PUT",
      `/forest/${ws}/work-state`,
      { step: `Rotate ${SECRET}`, taskId: task.id },
      {},
      "dev-1",
    ),
    await forest.agent("/approvals", {
      action: "close_task",
      targetId: task.id,
      value: "done",
      reason: `Closes ${SECRET}`,
      doneRef: "https://github.com/agolubenk/tAIBE/pull/1",
    }),
  ];
  expect(steps.map((step) => step.status)).toEqual([200, 200, 200, 200, 200]);
  return { forest, taskId: task.id };
}

describe("API integration: forest text for callers with a token (TB-204)", () => {
  beforeEach(resetTestDatabase);

  it("masks every forest read that carries the text; the owner reads it raw", async () => {
    const { forest, taskId } = await setup();
    const projectId = forest.project.id;
    const routes = [
      `/cards/${taskId}/context`,
      `/cards/${taskId}/meta`,
      `/cards/${taskId}/history`,
      `/cards/${taskId}/place`,
      "/trees",
      `/trees/${taskId}`,
      `/bugs?projectId=${projectId}`,
      `/workers?projectId=${projectId}`,
      "/fires",
      "/approvals",
      "/work-state",
    ];

    for (const route of routes) {
      const own = await forest.owner(route);
      const read = await forest.agent(route);
      const text = JSON.stringify(read.body);
      expect({ route, owner: own.status, agent: read.status }).toEqual({
        route,
        owner: 200,
        agent: 200,
      });
      const carries = JSON.stringify(own.body).includes(SECRET);
      expect({ route, carries }).toEqual({ route, carries: true });
      expect({ route, leaks: text.includes(SECRET) }).toEqual({
        route,
        leaks: false,
      });
      expect({ route, masked: text.includes(KEY_MARK) }).toEqual({
        route,
        masked: true,
      });
    }
  });

  it("masks the reads whose text depends on the agent's own actions", async () => {
    const { forest, taskId } = await setup();
    const lease = await forest.agent("/leases", { taskId }, "dev-1");
    expect(lease.status).toBe(200);
    for (const route of ["/graph", "/journal", "/leases"]) {
      const read = await forest.agent(route);
      const leaks = JSON.stringify(read.body).includes(SECRET);
      expect({ route, status: read.status }).toEqual({ route, status: 200 });
      expect({ route, leaks }).toEqual({ route, leaks: false });
    }
  });

  it("keeps the page cursor readable, so the agent reads the next pages", async () => {
    const { forest } = await setup();
    const second = await addTask(forest.project.id, "Second");
    if (!second) throw new Error("fixture");
    const asked = await forest.agent("/approvals", {
      action: "close_task",
      targetId: second.id,
      value: "done",
      reason: `Closes ${SECRET}`,
      doneRef: "https://github.com/agolubenk/tAIBE/pull/2",
    });
    expect(asked.status).toBe(200);

    const routes = [
      "/journal?actor=all&take=1",
      "/approvals?take=1",
      "/graph?take=1",
    ];
    for (const route of routes) {
      const own = await forest.owner(route);
      const read = await forest.agent(route);
      expect({ route, status: read.status }).toEqual({ route, status: 200 });
      expect({ route, cursor: read.body.nextCursor }).toEqual({
        route,
        cursor: own.body.nextCursor,
      });
      expect(read.body.nextCursor).toEqual(expect.any(String));

      const next = await forest.agent(
        `${route}&cursor=${read.body.nextCursor}`,
      );
      const leaks = JSON.stringify(next.body).includes(SECRET);
      expect({ route, status: next.status }).toEqual({ route, status: 200 });
      expect({ route, leaks }).toEqual({ route, leaks: false });
    }
  });

  it("gives the stored value back to a marker the agent writes back", async () => {
    const { forest, taskId } = await setup();
    const ws = forest.workspace.id;
    const lease = await forest.agent("/leases", { taskId }, "dev-1");
    expect(lease.status).toBe(200);
    const fence = { "x-t-boards-fence": String(lease.body.fencingToken) };
    const path = `/forest/${ws}/cards/${taskId}/meta`;

    const read = await forest.agent(`/cards/${taskId}/meta`);
    expect(read.body.contextPack).toBe(
      `Context: token ${KEY_MARK}\n\nRotate it first.`,
    );
    const put = await forest.agentApi(
      "PUT",
      path,
      { contextPack: `${read.body.contextPack}\n\nThen redeploy.` },
      fence,
      "dev-1",
    );
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain(SECRET);

    const [row] = await db
      .select({ contextPack: cardMetaTable.contextPack })
      .from(cardMetaTable)
      .where(eq(cardMetaTable.taskId, taskId));
    expect(row?.contextPack).toBe(
      `Context: token ${SECRET}\n\nRotate it first.\n\nThen redeploy.`,
    );

    const moved = await forest.agentApi(
      "PUT",
      path,
      { contextPack: `Context: ${KEY_MARK}\n\nThen redeploy.` },
      fence,
      "dev-1",
    );
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe("REDACTED_MARKERS_MISMATCH");
  });
});
