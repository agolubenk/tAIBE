import { decideAndApply, markFailed } from "../approval/decide-and-apply";
import { recordDeferral } from "./apply-deferral";
import { approvalItemData, approvalItemId, itemNonce } from "./item-text";
import { ApplyDeferred, eachRow, withoutPaused } from "./each-row";
import { journalQueue, ownerQueueActor } from "./queue-actor";
import {
  type QueueClient,
  QueueConflict,
  type QueueDoc,
  QueueRejected,
} from "./queue-client";
import type { OwnerQueueConfig } from "./queue-config";
import { lastWriter, readAnswer } from "./read-answer";
import { showOutcome } from "./show-outcome";
import {
  type ApprovalRow,
  claimItem,
  itemCard,
  outcomeToShow,
  pendingWithItem,
  pendingWithoutItem,
  releaseClaim,
  saveItemState,
  stillPending,
  taskKeys,
  workspaceName,
} from "./sync-store";

export type SyncDeps = {
  client: QueueClient;
  config: OwnerQueueConfig;
  now: () => Date;
};

const RESTORED_STATUS = "planned";
const CLAIM_GRACE_MS = 2 * 60 * 1000;
// The queue takes 120 writes a minute per token and a pass runs every 30 s:
// new items per pass stay well under half of that, the rest go next pass.
export const CREATE_PER_PASS = 30;
// itemId → first pass that found a claimed item missing (per process).
const missingSince = new Map<string, number>();
const OWN_STATUS_NOTE = "Статус этого пункта ведёт только t-boards.";

async function itemData(deps: SyncDeps, row: ApprovalRow) {
  return approvalItemData({
    approval: row,
    workspaceName: await workspaceName(row.workspaceId),
    card: await itemCard(row),
    taskKeys: await taskKeys(row),
    now: deps.now(),
  });
}

// Step 1. The claim comes first (AC-23); a failed write gives it back.
async function createItem(deps: SyncDeps, row: ApprovalRow) {
  const product = deps.config.products.get(row.workspaceId);
  if (!product) return;
  const itemId = approvalItemId(product, row.id, itemNonce());
  if (!(await claimItem(row.id, itemId))) return;
  try {
    const doc = await deps.client.put(
      "items",
      itemId,
      await itemData(deps, row),
      0,
    );
    await saveItemState(row.id, itemId, {
      version: doc.version,
      synced: "pending",
    });
  } catch (error) {
    // A refused document (400/422) was not written: free the claim, so the
    // try after the pause makes a new item; each-row.ts journals and pauses.
    if (error instanceof QueueRejected) {
      await releaseClaim(row.id, itemId);
      throw error;
    }
    // A timeout or 5xx may still have written the item: the claim stays
    // without a version, and the next pass adopts the item or, once it is
    // missing for CLAIM_GRACE_MS, frees the claim (correctness r2).
    if (!(error instanceof QueueConflict)) throw error;
    await releaseClaim(row.id, itemId);
    // Someone planted an item under this id (AC-17): never ours, so it is
    // archived and flagged; the next pass makes a new nonce.
    await deps.client
      .patch("items", itemId, { archived: true })
      .catch(() => {});
    await deps.client
      .patch("checks", itemId, {
        agentStatus: "done",
        agentNote: "Поддельный пункт, не отвечайте.",
      })
      .catch(() => {});
    await journalQueue(
      row.workspaceId,
      "queue.collision",
      row.id,
      `item ${itemId}`,
    );
  }
}

// Step 2 (AC-22): a foreign write to a pending item gets t-boards' text back.
async function restoreItem(
  deps: SyncDeps,
  row: ApprovalRow,
  itemId: string,
  item: QueueDoc,
) {
  // The request may have been decided in t-boards since this pass read it
  // (Control r1, F2): a decided request's item is never put back.
  if (!(await stillPending(row.id))) return;
  const doc = await deps.client.put(
    "items",
    itemId,
    { ...(await itemData(deps, row)), archived: false },
    item.version,
  );
  await saveItemState(row.id, itemId, { version: doc.version });
  await deps.client
    .patch("checks", itemId, {
      agentNote: "Пункт правили не из t-boards — проверьте текст.",
    })
    .catch(() => {});
  await journalQueue(
    row.workspaceId,
    "queue.foreign_edit",
    row.id,
    `item ${itemId} v${row.queueItemVersion ?? "?"} → v${item.version}, restored as v${doc.version}`,
  );
}

// R-15 (AC-20): t-boards never takes a decision from the agent status; a
// status it did not write is put back. t-boards itself writes no status on a
// new item, «blocked» on a tick without a choice and «planned» on a restore.
async function guardStatus(
  deps: SyncDeps,
  row: ApprovalRow,
  itemId: string,
  check: QueueDoc | null,
) {
  const status = check?.data.agentStatus;
  if (status === undefined || status === null) return;
  const own =
    row.queueSyncedStatus === "undecided" ? "blocked" : RESTORED_STATUS;
  if (status === own) return;
  await deps.client.patch("checks", itemId, {
    agentStatus: own,
    agentNote: OWN_STATUS_NOTE,
  });
  await journalQueue(
    row.workspaceId,
    "queue.foreign_status",
    row.id,
    `item ${itemId}: ${String(status)} → ${own}`,
  );
}

// The item is not in the queue. Without a saved version another instance
// may still be writing it (AC-23): only a claim missing for CLAIM_GRACE_MS is
// a crash between the claim and the write, and the next pass puts a fresh
// item. An item t-boards wrote can be deleted only by the owner (the queue
// refuses agents): the request stays answerable in t-boards, no new item.
async function itemMissing(deps: SyncDeps, row: ApprovalRow, itemId: string) {
  if (row.queueItemVersion === null) {
    const now = deps.now().getTime();
    const since = missingSince.get(itemId) ?? now;
    missingSince.set(itemId, since);
    if (now - since < CLAIM_GRACE_MS) return;
    missingSince.delete(itemId);
    await releaseClaim(row.id, itemId);
    return;
  }
  await saveItemState(row.id, itemId, { synced: "deleted" });
  await journalQueue(
    row.workspaceId,
    "queue.item_deleted",
    row.id,
    `item ${itemId} deleted in the queue; the request waits in t-boards`,
    "allowed",
  );
}

// Steps 2 and 3 for one pending request with an item.
async function readPending(deps: SyncDeps, row: ApprovalRow) {
  const itemId = row.queueItemId;
  if (!itemId || row.queueSyncedStatus === "deleted") return;
  const item = await deps.client.get("items", itemId);
  if (!item) return itemMissing(deps, row, itemId);
  missingSince.delete(itemId);
  const product = deps.config.products.get(row.workspaceId);
  if (item.product && item.product !== product) {
    if (row.queueSyncedStatus !== "product_mismatch") {
      await saveItemState(row.id, itemId, { synced: "product_mismatch" });
      await journalQueue(
        row.workspaceId,
        "queue.product_mismatch",
        row.id,
        `item ${itemId} product ${item.product}, workspace product ${product ?? "—"}`,
      );
    }
    return;
  }
  // Written, but the version not saved (the writer crashed or is a parallel
  // instance): an item whose only writer is t-boards is adopted as it is.
  if (row.queueItemVersion === null) {
    const events = await deps.client.history("items", itemId);
    if (
      events.length > 0 &&
      events.every((event) => event.actor === deps.config.tokenName)
    ) {
      await saveItemState(row.id, itemId, {
        version: item.version,
        synced: "pending",
      });
      return;
    }
  }
  const changed = item.version !== row.queueItemVersion;
  const check = await deps.client.get("checks", itemId);
  const choice = check?.data.choice;
  if (choice !== "yes" && choice !== "no") {
    if (changed) return restoreItem(deps, row, itemId, item);
    if (check?.data.done === true && row.queueSyncedStatus !== "undecided") {
      await deps.client.patch("checks", itemId, {
        agentStatus: "blocked",
        agentNote: "Нажмите «Да» или «Нет»: галочка без выбора — не решение.",
      });
      await saveItemState(row.id, itemId, { synced: "undecided" });
      return;
    }
    return guardStatus(deps, row, itemId, check);
  }

  const answer = readAnswer(check, await deps.client.history("checks", itemId));
  if (answer.kind !== "yes" && answer.kind !== "no") return;
  // R-7: an answer after the term is left to the expiry pass.
  if (answer.answeredAt > row.expiresAt) return;
  const actor = await ownerQueueActor(row.workspaceId);
  if (!actor) {
    await journalQueue(
      row.workspaceId,
      "queue.skip",
      row.id,
      "workspace has no owner",
    );
    return;
  }
  const decided = {
    via: "queue" as const,
    answeredAt: answer.answeredAt,
    answeredBy: answer.answeredBy,
    note: answer.note,
    queueItemId: itemId,
    queueItemVersion: item.version,
  };
  // R-4: the version decides; the last writer is only the second check.
  if (
    changed ||
    lastWriter(await deps.client.history("items", itemId)) !==
      deps.config.tokenName
  ) {
    await markFailed(
      row.id,
      row.workspaceId,
      actor,
      decided,
      "queue_item_changed",
    );
    return;
  }
  try {
    await decideAndApply({
      approvalId: row.id,
      workspaceId: row.workspaceId,
      decision: answer.kind === "yes" ? "approved" : "rejected",
      actor,
      answer: decided,
    });
  } catch (error) {
    await deferApply(deps, row, itemId, { actor, decided }, error);
  }
}

// TB-114 п. 3: the «Да» did not apply. Tries 1 to APPLY_TRIES − 1 say so in
// the item as «doing» and wait the pause (each-row.ts): the pass repeats the
// apply itself, so the item must not come back to the owner («blocked» after
// an answer is «ждёт вас снова», open-rule.ts in ops-console; product lens on
// #227). The last try ends the request as failed, and step 4 asks the owner
// to file again with «blocked».
async function deferApply(
  deps: SyncDeps,
  row: ApprovalRow,
  itemId: string,
  answer: {
    actor: Parameters<typeof markFailed>[2];
    decided: Parameters<typeof markFailed>[3];
  },
  error: unknown,
) {
  const outcome = await recordDeferral(
    { id: row.id, synced: row.queueSyncedStatus },
    error,
    {
      fail: (reason) =>
        markFailed(
          row.id,
          row.workspaceId,
          answer.actor,
          answer.decided,
          reason,
        ),
      save: (synced) => saveItemState(row.id, itemId, { synced }),
      note: (text) =>
        deps.client.patch("checks", itemId, {
          agentStatus: "doing",
          agentNote: text,
        }),
    },
  );
  if (outcome === "deferred") throw new ApplyDeferred(error);
}

// One pass ends early, without an error, once it spent its share of the
// queue's write limit or its time (resources r2); the rest goes next pass.
export const WRITES_PER_PASS = 50;
export const PASS_DEADLINE_MS = 25_000;

class PassBudgetSpent extends Error {}

// Counts writes; refuses one more once the pass spent its share.
function budgeted(client: QueueClient, deadline: number): QueueClient {
  let writes = 0;
  const spend = () => {
    writes += 1;
    if (writes > WRITES_PER_PASS || Date.now() > deadline) {
      throw new PassBudgetSpent();
    }
  };
  return {
    get: (collection, id) => {
      if (Date.now() > deadline) throw new PassBudgetSpent();
      return client.get(collection, id);
    },
    history: (collection, id) => client.history(collection, id),
    put: (collection, id, data, ifVersion) => {
      spend();
      return client.put(collection, id, data, ifVersion);
    },
    patch: (collection, id, data, ifVersion) => {
      spend();
      return client.patch(collection, id, data, ifVersion);
    },
  };
}

// One pass over the queue (spec «Синхронизация»). Per-request failures —
// each-row.ts (a 409 or a refused document does not stop the others).
export async function syncPass(input: SyncDeps) {
  const deps = {
    ...input,
    client: budgeted(input.client, Date.now() + PASS_DEADLINE_MS),
  };
  const workspaceIds = [...deps.config.products.keys()];
  try {
    const fresh = await pendingWithoutItem(workspaceIds, deps.now());
    await eachRow(
      withoutPaused(fresh).slice(0, CREATE_PER_PASS),
      (row) => createItem(deps, row),
      journalQueue,
    );
    await eachRow(
      await pendingWithItem(workspaceIds),
      (row) => readPending(deps, row),
      journalQueue,
    );
    await eachRow(
      await outcomeToShow(workspaceIds),
      (row) => showOutcome(deps.client, row),
      journalQueue,
    );
  } catch (error) {
    if (!(error instanceof PassBudgetSpent)) throw error;
  }
}
