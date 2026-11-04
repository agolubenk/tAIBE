import { and, eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db from "../../apps/api/src/database";
import {
  agentJournalTable,
  cardMetaTable,
} from "../../apps/api/src/database/forest-schema";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

type Forest = Awaited<ReturnType<typeof createForest>>;

const meta = (taskId: string) => `/cards/${taskId}/meta`;

async function lease(forest: Forest, taskId: string, session = "dev-1") {
  const res = await forest.agent("/leases", { taskId }, session);
  expect(res.status).toBe(200);
  return String(res.body.fencingToken);
}

function agentPut(
  forest: Forest,
  taskId: string,
  body: unknown,
  fence?: string,
) {
  return forest.agentApi(
    "PUT",
    `/forest/${forest.workspace.id}${meta(taskId)}`,
    body,
    fence ? { "x-t-boards-fence": fence } : {},
    "dev-1",
  );
}

function ownerPut(forest: Forest, taskId: string, body: unknown) {
  return forest.ownerApi(
    "PUT",
    `/forest/${forest.workspace.id}${meta(taskId)}`,
    body,
  );
}

async function journal(action: string, targetId: string) {
  return db
    .select()
    .from(agentJournalTable)
    .where(
      and(
        eq(agentJournalTable.action, action),
        eq(agentJournalTable.targetId, targetId),
      ),
    );
}

async function agentCard(forest: Forest) {
  const created = await forest.agentApi("POST", `/task/${forest.project.id}`, {
    title: "Finding",
    description: "",
    priority: "low",
    status: "to-do",
  });
  expect(created.status).toBe(200);
  return String(created.body.id);
}

describe("API integration: card fields (R-024, R-081)", () => {
  beforeEach(resetTestDatabase);

  it("answers the defaults for a card nobody wrote fields for", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id);

    const res = await forest.owner(meta(task.id));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      taskId: task.id,
      kind: "task",
      halfBaked: false,
      pullRequests: [],
      updatedAt: null,
    });
  });

  it("lets the owner set Notion fields and keeps the Backlog ID unique", async () => {
    const forest = await createForest();
    const first = await addTask(forest.project.id, "One");
    const second = await addTask(forest.project.id, "Two");

    const set = await ownerPut(forest, first.id, {
      kind: "bug",
      severity: "P1",
      backlogId: "B-65",
      report: "Steps",
      costUsd: 1.23456,
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      kind: "bug",
      backlogId: "B-65",
      costUsd: 1.2346,
    });

    const cleared = await ownerPut(forest, first.id, { severity: null });
    expect(cleared.body).toMatchObject({ severity: null, backlogId: "B-65" });

    const taken = await ownerPut(forest, second.id, { backlogId: "B-65" });
    expect(taken.status).toBe(409);

    const empty = await ownerPut(forest, second.id, {});
    expect(empty.status).toBe(400);
  });

  it("lets an agent write its own fields under its lease, not the owner's Notion fields", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Owner task");

    const noLease = await agentPut(forest, task.id, { branch: "fix/x" });
    expect(noLease.status).toBe(409);

    const token = await lease(forest, task.id);
    const own = await agentPut(
      forest,
      task.id,
      { branch: "fix/x", pullRequests: ["#12"], tokens: 900 },
      token,
    );
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ branch: "fix/x", tokens: 900 });

    const notion = await agentPut(forest, task.id, { severity: "P0" }, token);
    expect(notion.status).toBe(403);
    expect(notion.body.message).toContain("agent_forbidden");

    const rows = await journal("card.meta", task.id);
    expect(rows.map((row) => row.outcome).sort()).toEqual([
      "allowed",
      "denied",
      "denied",
    ]);
  });

  it("lets an agent set Notion fields on a card it created", async () => {
    const forest = await createForest();
    const own = await agentCard(forest);
    const token = await lease(forest, own);

    const res = await agentPut(
      forest,
      own,
      { kind: "bug", severity: "P2", report: "found it" },
      token,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "bug", severity: "P2" });
  });

  it("keeps half-baked the owner's gate: an agent neither moves it nor takes the card", async () => {
    const forest = await createForest();
    const own = await agentCard(forest);
    const token = await lease(forest, own);

    const agentMark = await agentPut(forest, own, { halfBaked: true }, token);
    expect(agentMark.status).toBe(403);
    expect(agentMark.body.message).toContain("owner_session_required");

    const idea = await addTask(forest.project.id, "Raw idea");
    expect((await ownerPut(forest, idea.id, { halfBaked: true })).status).toBe(
      200,
    );
    const taken = await forest.agent("/leases", { taskId: idea.id }, "dev-1");
    expect(taken.status).toBe(403);
    expect(taken.body.message).toContain("half_baked");
    const [denied] = await journal("lease.acquire", idea.id);
    expect(denied?.outcome).toBe("denied");

    expect((await ownerPut(forest, idea.id, { halfBaked: false })).status).toBe(
      200,
    );
    expect(
      (await forest.agent("/leases", { taskId: idea.id }, "dev-1")).status,
    ).toBe(200);
  });

  async function notionCard(forest: Forest) {
    const task = await addTask(forest.project.id, "From Notion");
    await db.insert(cardMetaTable).values({
      taskId: task.id,
      workspaceId: forest.workspace.id,
      notionPageId: "notion-page-1",
      updatedBy: "import",
    });
    return task;
  }
  const mirrorOn = (workspaceId: string) => {
    vi.stubEnv("NOTION_MIRROR_WORKSPACE_ID", workspaceId);
    vi.stubEnv("NOTION_MIRROR_TOKEN_FILE", "/run/secrets/notion-token");
    vi.stubEnv("NOTION_MIRROR_DATABASES", "db-1");
  };
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps a mirrored card's Notion fields read-only, agent fields open (R-081)", async () => {
    const forest = await createForest();
    mirrorOn(forest.workspace.id);
    const task = await notionCard(forest);

    expect((await forest.owner(meta(task.id))).body).toMatchObject({
      mirrored: true,
    });
    const owner = await ownerPut(forest, task.id, { severity: "P0" });
    expect(owner.status).toBe(403);
    expect(owner.body.message).toContain("mirror_read_only");
    const idea = await ownerPut(forest, task.id, { halfBaked: true });
    expect(idea.status).toBe(403);
    expect(idea.body.message).toContain("mirror_read_only");

    const agentFields = await ownerPut(forest, task.id, { executor: "dev-1" });
    expect(agentFields.status).toBe(200);
  });

  it("gives a Notion card's fields to the owner once the mirror is off (TB-71)", async () => {
    const forest = await createForest();
    // The mirror runs, but for another workspace: off for this one.
    mirrorOn("another-workspace");
    const task = await notionCard(forest);

    expect((await forest.owner(meta(task.id))).body).toMatchObject({
      notionPageId: "notion-page-1",
      mirrored: false,
    });
    const marked = await ownerPut(forest, task.id, { halfBaked: true });
    expect(marked.status).toBe(200);
    expect(marked.body).toMatchObject({ halfBaked: true, mirrored: false });
    expect((await ownerPut(forest, task.id, { halfBaked: false })).status).toBe(
      200,
    );
    expect((await ownerPut(forest, task.id, { severity: "P1" })).status).toBe(
      200,
    );

    // Half-baked stays the owner's alone (Q-011).
    const token = await lease(forest, task.id);
    const agentMark = await agentPut(
      forest,
      task.id,
      { halfBaked: true },
      token,
    );
    expect(agentMark.status).toBe(403);
    expect(agentMark.body.message).toContain("owner_session_required");
  });
});
