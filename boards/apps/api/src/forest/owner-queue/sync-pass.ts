import { decideAndApply, markFailed } from "../approval/decide-and-apply";
import { approvalItemData, approvalItemId, itemNonce } from "./item-text";
import { journalQueue, ownerQueueActor } from "./queue-actor";
import { type QueueClient, QueueConflict, type QueueDoc } from "./queue-client";
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
  workspaceName,
} from "./sync-store";

export type SyncDeps = {
  client: QueueClient;
  config: OwnerQueueConfig;
  now: () => Date;
};

const RESTORED_STATUS = "planned";
const CLAIM_GRACE_MS = 2 * 60 * 1000;
// itemId → first pass that found a claimed item missing (per process).
const missingSince = new Map<string, number>();
const OWN_STATUS_NOTE = "Статус этого пункта ведёт только t-boards.";

async function itemData(deps: SyncDeps, row: ApprovalRow) {
  return approvalItemData({
    approval: row,
    workspaceName: await workspaceName(row.workspaceId),
    card: await itemCard(row),
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
    await releaseClaim(row.id, itemId);
    if (!(error instanceof QueueConflict)) throw error;
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
// status it did not write is put back.
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

// Steps 2 and 3 for one pending request with an item.
async function readPending(deps: SyncDeps, row: ApprovalRow) {
  const itemId = row.queueItemId;
  if (!itemId) return;
  const item = await deps.client.get("items", itemId);
  if (!item) {
    // No version saved yet: another instance claimed the item and is still
    // writing it (AC-23). Only a claim missing for CLAIM_GRACE_MS is a crash
    // between the claim and the write.
    if (row.queueItemVersion === null) {
      const now = deps.now().getTime();
      const since = missingSince.get(itemId) ?? now;
      missingSince.set(itemId, since);
      if (now - since < CLAIM_GRACE_MS) return;
    }
    missingSince.delete(itemId);
    // Deleted by the owner, or never written: the next pass puts a fresh item.
    await releaseClaim(row.id, itemId);
    await journalQueue(
      row.workspaceId,
      "queue.foreign_edit",
      row.id,
      `item ${itemId} gone`,
    );
    return;
  }
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
  const writer = lastWriter(await deps.client.history("items", itemId));
  if (changed || writer !== deps.config.tokenName) {
    await markFailed(
      row.id,
      row.workspaceId,
      actor,
      decided,
      "queue_item_changed",
    );
    return;
  }
  await decideAndApply({
    approvalId: row.id,
    workspaceId: row.workspaceId,
    decision: answer.kind === "yes" ? "approved" : "rejected",
    actor,
    answer: decided,
  });
}

// One pass over the queue (spec «Синхронизация»). A failure of the queue or
// the database ends the pass; the caller backs off and tries again.
export async function syncPass(deps: SyncDeps) {
  const workspaceIds = [...deps.config.products.keys()];
  for (const row of await pendingWithoutItem(workspaceIds, deps.now())) {
    await createItem(deps, row);
  }
  for (const row of await pendingWithItem(workspaceIds)) {
    await readPending(deps, row);
  }
  for (const row of await outcomeToShow(workspaceIds)) {
    await showOutcome(deps.client, row);
  }
}
