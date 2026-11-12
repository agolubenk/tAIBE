import { and, asc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import db from "../../database";
import { ownerApprovalTable } from "../../database/forest-schema";
import { journalQueue } from "./queue-actor";
import type { QueueClient } from "./queue-client";
import type { OwnerQueueConfig } from "./queue-config";
import { readAnswer } from "./read-answer";
import { type ApprovalRow, PASS_TAKE } from "./sync-store";

const INVARIANT_AFTER_MS = 5 * 60 * 1000;
const invariantSeen = new Set<string>();

async function expire(row: ApprovalRow, now: Date, detail: string) {
  const [expired] = await db
    .update(ownerApprovalTable)
    .set({ status: "expired" })
    .where(
      and(
        eq(ownerApprovalTable.id, row.id),
        eq(ownerApprovalTable.status, "pending"),
        lt(ownerApprovalTable.expiresAt, now),
      ),
    )
    .returning({ id: ownerApprovalTable.id });
  if (expired) {
    await journalQueue(
      row.workspaceId,
      "approval.expired",
      row.id,
      detail,
      "allowed",
    );
  }
}

// R-7: a request whose item may hold a timely answer expires only after a
// successful read shows no decision made before the term. Without the queue
// (not configured, or not this workspace) the term alone decides.
async function expireWithItem(
  row: ApprovalRow,
  now: Date,
  client: QueueClient,
) {
  const itemId = row.queueItemId as string;
  let answer: ReturnType<typeof readAnswer>;
  try {
    const check = await client.get("checks", itemId);
    const choice = check?.data.choice;
    const events =
      choice === "yes" || choice === "no"
        ? await client.history("checks", itemId)
        : [];
    answer = readAnswer(check, events);
  } catch {
    return; // the queue is down: no read, no expiry
  }
  if (
    (answer.kind === "yes" || answer.kind === "no") &&
    answer.answeredAt <= row.expiresAt
  ) {
    return; // a timely answer: the sync pass applies it
  }
  const note =
    answer.kind === "yes" || answer.kind === "no"
      ? `late answer ${answer.kind} at ${answer.answeredAt.toISOString()}${answer.note ? ` note=${JSON.stringify(answer.note)}` : ""}`
      : `no answer by ${row.expiresAt.toISOString()}`;
  await expire(row, now, `item ${itemId}: ${note}`);
}

// Every 5 minutes (spec R-7, «approval.invariant»).
export async function expiryPass(
  queue: { client: QueueClient; config: OwnerQueueConfig } | null,
  now: Date = new Date(),
) {
  const due = await db
    .select()
    .from(ownerApprovalTable)
    .where(
      and(
        eq(ownerApprovalTable.status, "pending"),
        lt(ownerApprovalTable.expiresAt, now),
      ),
    )
    .orderBy(asc(ownerApprovalTable.expiresAt))
    .limit(PASS_TAKE);
  for (const row of due) {
    const synced = queue?.config.products.has(row.workspaceId) ?? false;
    if (row.queueItemId && queue && synced) {
      await expireWithItem(row, now, queue.client);
    } else {
      await expire(row, now, `no answer by ${row.expiresAt.toISOString()}`);
    }
  }

  // «approved» is not a state of its own any more: one that stays longer than
  // 5 minutes is a leftover for R-11, journaled once per process.
  const stuck = await db
    .select()
    .from(ownerApprovalTable)
    .where(
      and(
        eq(ownerApprovalTable.status, "approved"),
        isNull(ownerApprovalTable.consumedAt),
        isNotNull(ownerApprovalTable.decidedAt),
        lt(
          ownerApprovalTable.decidedAt,
          new Date(now.getTime() - INVARIANT_AFTER_MS),
        ),
      ),
    )
    .limit(PASS_TAKE);
  for (const row of stuck) {
    if (invariantSeen.has(row.id)) continue;
    invariantSeen.add(row.id);
    await journalQueue(
      row.workspaceId,
      "approval.invariant",
      row.id,
      `approved since ${row.decidedAt?.toISOString() ?? "?"}, not applied`,
    );
  }
}
