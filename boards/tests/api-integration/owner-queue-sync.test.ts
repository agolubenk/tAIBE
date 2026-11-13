import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  agentJournalTable,
  ownerApprovalTable,
} from "../../apps/api/src/database/forest-schema";
import type { OwnerQueueConfig } from "../../apps/api/src/forest/owner-queue/queue-config";
import {
  resetRejectedForTest,
  withoutPaused,
} from "../../apps/api/src/forest/owner-queue/each-row";
import {
  CREATE_PER_PASS,
  type SyncDeps,
  syncPass,
} from "../../apps/api/src/forest/owner-queue/sync-pass";
import { resetTestDatabase } from "./helpers/database";
import { holdTaskLocks } from "./helpers/hold-locks";
import { FakeQueue } from "./helpers/fake-queue";
import { addTask, createForest } from "./helpers/forest";

const TOKEN = "t-boards";
type Forest = Awaited<ReturnType<typeof createForest>>;

function setup(forest: Forest) {
  const queue = new FakeQueue();
  const config: OwnerQueueConfig = {
    url: "http://queue.test",
    tokenFile: "/dev/null",
    tokenName: TOKEN,
    products: new Map([[forest.workspace.id, "hr-helper"]]),
  };
  const deps: SyncDeps = {
    client: queue.as(TOKEN),
    config,
    now: () => new Date(),
  };
  return { queue, deps };
}

async function requestClose(forest: Forest, taskId: string) {
  const res = await forest.agent("/approvals", {
    action: "close_task",
    targetId: taskId,
    value: "done",
    reason: "агент: готово",
    doneRef: "https://github.com/agolubenk/tAIBE/pull/132",
  });
  expect(res.status).toBe(200);
  return String(res.body.id);
}

async function approval(id: string) {
  const [row] = await db
    .select()
    .from(ownerApprovalTable)
    .where(eq(ownerApprovalTable.id, id));
  return row;
}

async function taskStatus(id: string) {
  const [row] = await db
    .select({ status: schema.taskTable.status })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, id));
  return row?.status;
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

describe("API integration: owner-queue sync (TB-102)", () => {
  beforeEach(resetTestDatabase);

  it("puts the item, applies «Да» from the queue once and shows the outcome (AC-1, AC-2, AC-4)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { queue, deps } = setup(forest);
    const id = await requestClose(forest, task.id);

    await syncPass(deps);
    const [itemId] = queue.itemIds();
    expect(itemId).toMatch(new RegExp(`^d-tba-${id}-[a-z0-9]{6}$`));
    const item = queue.doc("items", itemId as string);
    expect(item?.data).toMatchObject({ kind: "decision", source: "t-boards" });
    expect(String(item?.data.body)).toContain("Текст агента:\nагент: готово");
    expect(String(item?.data.body)).toContain("pull/132");

    await queue
      .as("owner")
      .patch("checks", itemId as string, { done: true, choice: "yes" });
    await syncPass(deps);
    await syncPass(deps);

    expect((await approval(id))?.status).toBe("consumed");
    expect((await approval(id))?.decidedVia).toBe("queue");
    expect(await taskStatus(task.id)).toBe("done");
    expect(await journal("approval.applied", task.id)).toHaveLength(1);
    const [approved] = await journal("approval.approved", task.id);
    expect(approved?.detail).toContain("via=queue by=owner");
    expect(queue.doc("checks", itemId as string)?.data).toMatchObject({
      agentStatus: "done",
    });
  });

  // TB-108 R-3, R-5: one item for a batch; after «Да» it shows the report.
  it("puts one item for a batch close and shows the report after «Да»", async () => {
    const forest = await createForest();
    const cards = await Promise.all(
      ["One", "Two", "Three"].map((title) => addTask(forest.project.id, title)),
    );
    const ids = cards.map((card) => String(card?.id));
    const { queue, deps } = setup(forest);
    const asked = await forest.agent("/approvals", {
      action: "close_task",
      targetId: forest.workspace.id,
      taskIds: ids,
      doneReason: "import",
      reason: "закрыты в Notion",
    });
    expect(asked.status).toBe(200);

    await syncPass(deps);
    expect(queue.itemIds()).toHaveLength(1);
    const [itemId] = queue.itemIds();
    const item = queue.doc("items", itemId as string);
    expect(String(item?.data.title)).toContain("закрыть карточки (3)");
    expect(String(item?.data.body)).toContain("Карточек: 3");
    expect(String(item?.data.body)).toContain("Все карточки заявки:");

    await db
      .update(schema.taskTable)
      .set({ status: "in-progress" })
      .where(eq(schema.taskTable.id, ids[2] as string));
    await queue
      .as("owner")
      .patch("checks", itemId as string, { done: true, choice: "yes" });
    await syncPass(deps);
    await syncPass(deps);

    expect((await approval(String(asked.body.id)))?.status).toBe("consumed");
    expect(await taskStatus(ids[0] as string)).toBe("done");
    expect(await taskStatus(ids[2] as string)).toBe("in-progress");
    const check = queue.doc("checks", itemId as string)?.data;
    expect(check?.agentStatus).toBe("done");
    expect(String(check?.agentNote)).toContain(
      "Итог: закрыто 2 из 3; пропущено 1:",
    );
  });

  // Gate (3), AC-23: the creation is claimed by a conditional update.
  it("puts exactly one item when two instances run the pass at once (AC-23)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { queue, deps } = setup(forest);
    const id = await requestClose(forest, task.id);

    await Promise.all([syncPass(deps), syncPass({ ...deps })]);

    expect(queue.itemIds()).toHaveLength(1);
    expect((await approval(id))?.queueItemId).toBe(queue.itemIds()[0]);
  });

  // Gate (2), AC-22: a foreign write to a pending item is undone.
  it("restores its text after a foreign edit and keeps waiting (AC-22)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { queue, deps } = setup(forest);
    const id = await requestClose(forest, task.id);
    await syncPass(deps);
    const itemId = queue.itemIds()[0] as string;
    const original = queue.doc("items", itemId)?.data;

    await queue
      .as("other-agent")
      .patch("items", itemId, { archived: true, title: "Закрыть всё" });
    await syncPass(deps);

    const restored = queue.doc("items", itemId);
    expect(restored?.data.archived).toBe(false);
    expect(restored?.data.title).toBe(original?.title);
    expect((await approval(id))?.queueItemVersion).toBe(restored?.version);
    expect((await approval(id))?.status).toBe("pending");
    expect(await journal("queue.foreign_edit", id)).toHaveLength(1);

    // After the restore the owner's «Да» counts again.
    await queue
      .as("owner")
      .patch("checks", itemId, { done: true, choice: "yes" });
    await syncPass(deps);
    expect((await approval(id))?.status).toBe("consumed");
  });

  // Gate (1), AC-5 and AC-22: the version decides, the writer is the second check.
  it("does not apply «Да» to an item someone else changed (AC-5)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { queue, deps } = setup(forest);
    const id = await requestClose(forest, task.id);
    await syncPass(deps);
    const itemId = queue.itemIds()[0] as string;

    await queue.as("other-agent").patch("items", itemId, { title: "Подмена" });
    await queue
      .as("owner")
      .patch("checks", itemId, { done: true, choice: "yes" });
    await syncPass(deps);

    const row = await approval(id);
    expect(row?.status).toBe("failed");
    expect(row?.failReason).toBe("queue_item_changed");
    expect(await taskStatus(task.id)).toBe("to-do");
    expect(queue.doc("checks", itemId)?.data.agentStatus).toBe("blocked");
  });

  it("refuses «Да» when only the writer differs, with the same version (R-4)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { queue, deps } = setup(forest);
    const id = await requestClose(forest, task.id);
    await syncPass(deps);
    const itemId = queue.itemIds()[0] as string;
    // Same version as stored, but the journal names another writer.
    const log = queue.events.get(`items/${itemId}`);
    if (log?.[0]) log[0].actor = "other-agent";

    await queue
      .as("owner")
      .patch("checks", itemId, { done: true, choice: "yes" });
    await syncPass(deps);

    expect((await approval(id))?.failReason).toBe("queue_item_changed");
    expect(await taskStatus(task.id)).toBe("to-do");
  });

  it("puts back an agent status it did not write (AC-20)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { queue, deps } = setup(forest);
    const id = await requestClose(forest, task.id);
    await syncPass(deps);
    const itemId = queue.itemIds()[0] as string;

    await queue
      .as("other-agent")
      .patch("checks", itemId, { agentStatus: "done" });
    await syncPass(deps);

    expect(queue.doc("checks", itemId)?.data.agentStatus).toBe("planned");
    expect(await journal("queue.foreign_status", id)).toHaveLength(1);
    expect((await approval(id))?.status).toBe("pending");
  });

  it("refuses a close without doneRef or with a foreign link, before any item (AC-12, AC-21)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { queue, deps } = setup(forest);
    for (const extra of [
      {},
      { doneRef: "https://github.com/someone/else/pull/1" },
      { doneRef: "https://evil.test/agolubenk/tAIBE/pull/1" },
    ]) {
      const res = await forest.agent("/approvals", {
        action: "close_task",
        targetId: task.id,
        value: "done",
        reason: "x",
        ...extra,
      });
      expect(res.status).toBe(400);
    }
    await syncPass(deps);
    expect(queue.itemIds()).toHaveLength(0);
  });

  it("archives the item of a request decided in t-boards; a late «Да» changes nothing (AC-9, AC-15)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { queue, deps } = setup(forest);
    const id = await requestClose(forest, task.id);
    await syncPass(deps);
    const itemId = queue.itemIds()[0] as string;

    const decided = await forest.owner(`/approvals/${id}/decide`, {
      decision: "rejected",
    });
    expect(decided.body.status).toBe("rejected");
    await queue
      .as("owner")
      .patch("checks", itemId, { done: true, choice: "yes" });
    await syncPass(deps);

    expect((await approval(id))?.status).toBe("rejected");
    expect(await taskStatus(task.id)).toBe("to-do");
    expect(queue.doc("items", itemId)?.data.archived).toBe(true);
    expect(String(queue.doc("checks", itemId)?.data.agentNote)).toContain(
      "Уже решено",
    );
    expect(await journal("approval.late_answer", id)).toHaveLength(1);
  });

  // r1 #10: a version race on one item skips it; the pass goes on.
  it("keeps the pass going when one restore meets a version race", async () => {
    const forest = await createForest();
    const first = await addTask(forest.project.id, "First");
    const second = await addTask(forest.project.id, "Second");
    const { queue, deps } = setup(forest);
    const idA = await requestClose(forest, first.id);
    const idB = await requestClose(forest, second.id);
    await syncPass(deps);
    const itemA = (await approval(idA))?.queueItemId as string;
    const itemB = (await approval(idB))?.queueItemId as string;

    await queue.as("other-agent").patch("items", itemA, { title: "Подмена" });
    const racing = queue.as(TOKEN);
    const put = racing.put;
    racing.put = async (collection, id, data, ifVersion) => {
      if (id === itemA) {
        await queue.as("other-agent").patch("items", itemA, { title: "Ещё" });
      }
      return put(collection, id, data, ifVersion);
    };
    await queue
      .as("owner")
      .patch("checks", itemB, { done: true, choice: "yes" });
    await syncPass({ ...deps, client: racing });

    expect((await approval(idA))?.status).toBe("pending");
    expect((await approval(idB))?.status).toBe("consumed");
  });

  // r1 #5: an item written by t-boards whose version was not saved is
  // adopted, not «restored» into a false «changed».
  it("adopts its own item when the version was not saved", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { queue, deps } = setup(forest);
    const id = await requestClose(forest, task.id);
    await syncPass(deps);
    const itemId = (await approval(id))?.queueItemId as string;
    await db
      .update(ownerApprovalTable)
      .set({ queueItemVersion: null })
      .where(eq(ownerApprovalTable.id, id));

    await syncPass(deps);
    expect((await approval(id))?.queueItemVersion).toBe(
      queue.doc("items", itemId)?.version,
    );
    expect(await journal("queue.foreign_edit", id)).toHaveLength(0);
    await queue
      .as("owner")
      .patch("checks", itemId, { done: true, choice: "yes" });
    await syncPass(deps);
    expect((await approval(id))?.status).toBe("consumed");
  });

  it("does not bring back an item the owner deleted; t-boards still answers", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { queue, deps } = setup(forest);
    const id = await requestClose(forest, task.id);
    await syncPass(deps);
    const itemId = (await approval(id))?.queueItemId as string;
    queue.docs.delete(`items/${itemId}`);

    await syncPass(deps);
    await syncPass(deps);
    expect(queue.itemIds()).toHaveLength(0);
    expect(await journal("queue.item_deleted", id)).toHaveLength(1);

    const decided = await forest.owner(`/approvals/${id}/decide`, {
      decision: "approved",
    });
    expect(decided.body.status).toBe("consumed");
    await syncPass(deps);
    expect(queue.itemIds()).toHaveLength(0);
  });

  it("explains a failed «Да» in words, not codes (product r1)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { queue, deps } = setup(forest);
    const id = await requestClose(forest, task.id);
    await syncPass(deps);
    const itemId = (await approval(id))?.queueItemId as string;
    await queue.as("other-agent").patch("items", itemId, { title: "Подмена" });
    await queue
      .as("owner")
      .patch("checks", itemId, { done: true, choice: "yes" });
    await syncPass(deps);
    await syncPass(deps);

    const note = String(queue.doc("checks", itemId)?.data.agentNote);
    expect(note).toContain("правил не t-boards");
    expect(note).not.toContain("queue_item_changed");
  });

  // TB-114 п. 3: the owner said «Да» and nothing applied — the item says so
  // and counts the tries; the fifth fails the request and asks to file again.
  it("shows a deferred «Да» with its try, then fails it after 5 tries", async () => {
    const forest = await createForest();
    const cards = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        addTask(forest.project.id, `Busy ${i}`),
      ),
    );
    const ids = cards.map((card) => String(card?.id));
    const { queue, deps } = setup(forest);
    const asked = await forest.agent("/approvals", {
      action: "close_task",
      targetId: forest.workspace.id,
      taskIds: ids,
      doneReason: "import",
      reason: "закрыты в Notion",
    });
    expect(asked.status).toBe(200);
    const id = String(asked.body.id);
    await syncPass(deps);
    const itemId = (await approval(id))?.queueItemId as string;
    await queue
      .as("owner")
      .patch("checks", itemId, { done: true, choice: "yes" });
    const release = await holdTaskLocks(ids);
    try {
      // The first try cannot write its note either (queue down for checks):
      // the request still waits the pause, the batch does not run again.
      const patch = deps.client.patch;
      let noteFails = true;
      deps.client = {
        ...deps.client,
        patch: async (collection, docId, data, ifVersion) => {
          if (noteFails && collection === "checks") {
            noteFails = false;
            throw new Error("queue down");
          }
          return patch(collection, docId, data, ifVersion);
        },
      };
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      resetRejectedForTest();
      await syncPass(deps);
      expect(String(logged.mock.calls[0]?.[0])).toContain(
        `deferred try 1 of request ${id} not recorded`,
      );
      logged.mockRestore();
      expect(withoutPaused([{ id }])).toEqual([]);
      expect((await approval(id))?.status).toBe("pending");
      expect((await approval(id))?.queueSyncedStatus).not.toMatch(/^deferred:/);
      expect(queue.doc("checks", itemId)?.data.agentNote).toBeUndefined();

      resetRejectedForTest();
      await syncPass(deps);
      const check = queue.doc("checks", itemId)?.data;
      // The pass repeats the apply itself: nothing is asked of the owner.
      expect(check?.agentStatus).toBe("doing");
      expect(check?.agentNote).toBe(
        "Применение отложено: больше 5 карточек заняты другими записями, попытка 1 из 5.",
      );
      expect(queue.openToOwner(itemId)).toBe(false);
      expect((await approval(id))?.status).toBe("pending");
      expect((await approval(id))?.queueSyncedStatus).toBe("deferred:1");

      // Tries 2 to 4 went the same way; the fifth ends the request.
      await db
        .update(ownerApprovalTable)
        .set({ queueSyncedStatus: "deferred:4" })
        .where(eq(ownerApprovalTable.id, id));
      resetRejectedForTest();
      await syncPass(deps);
    } finally {
      await release();
    }
    const failed = await approval(id);
    expect(failed?.status).toBe("failed");
    expect(failed?.failReason).toBe("apply_deferred:locked");
    await syncPass(deps);
    const check = queue.doc("checks", itemId)?.data;
    expect(check?.agentStatus).toBe("blocked");
    expect(check?.agentNote).toBe(
      "Не применено: больше 5 карточек заняты другими записями, попыток: 5 — подай заново.",
    );
    // Now the owner is needed again: the item is back in the open ones.
    expect(queue.openToOwner(itemId)).toBe(true);
    expect(await taskStatus(ids[0] as string)).toBe("to-do");
  });

  // resources r2: new items per pass are capped; the rest go next pass.
  it("puts at most CREATE_PER_PASS new items in one pass", async () => {
    const forest = await createForest();
    const { queue, deps } = setup(forest);
    for (let i = 0; i <= CREATE_PER_PASS; i += 1) {
      const task = await addTask(forest.project.id, `Card ${i}`);
      await requestClose(forest, task.id);
    }
    await syncPass(deps);
    expect(queue.itemIds()).toHaveLength(CREATE_PER_PASS);
    await syncPass(deps);
    expect(queue.itemIds()).toHaveLength(CREATE_PER_PASS + 1);
  });

  it("hides the queue item id from the approval API (security r2)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Card");
    const { deps } = setup(forest);
    await requestClose(forest, task.id);
    await syncPass(deps);
    const list = await forest.agent("/approvals");
    expect(list.status).toBe(200);
    expect(list.body.items[0]).not.toHaveProperty("queueItemId");
  });
});
