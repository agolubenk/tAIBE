import { journalQueue } from "./queue-actor";
import type { QueueClient } from "./queue-client";
import { type ApprovalRow, saveItemState } from "./sync-store";

function moscow(date: Date | null): string {
  if (!date) return "";
  return `${date.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })} МСК`;
}

const WHERE: Record<string, string> = {
  queue: "в очереди",
  ui: "в t-boards",
};

const STATUS_WORD: Record<string, string> = {
  consumed: "применено",
  rejected: "отклонено",
  failed: "не применено",
  expired: "срок истёк",
};

// Step 4: the item shows the outcome as the agent status (F9, F22). An item
// the owner did not answer (decided in t-boards, expired) is archived (R-12,
// R-7). A late answer to a decided request changes nothing (R-13).
export async function showOutcome(client: QueueClient, row: ApprovalRow) {
  const itemId = row.queueItemId;
  if (!itemId) return;
  const word = STATUS_WORD[row.status];
  if (!word) {
    // Legacy «approved»: R-11 decides it; nothing to show yet.
    await saveItemState(row.id, itemId, { synced: row.status });
    return;
  }
  const where = WHERE[row.decidedVia ?? ""] ?? "";
  const when = moscow(row.decidedAt);
  const answeredHere = row.decidedVia === "queue";
  let note =
    row.status === "failed"
      ? `Не применено: ${row.failReason ?? "?"}. Заявку нужно подать заново.`
      : row.status === "expired"
        ? "Срок истёк."
        : `${word[0]?.toUpperCase()}${word.slice(1)} ${where} ${when}.`.replace(
            /\s+\./,
            ".",
          );
  if (!answeredHere && row.status !== "failed") {
    const check = await client.get("checks", itemId);
    const choice = check?.data.choice;
    if (choice === "yes" || choice === "no") {
      note = `Уже решено: ${word}${where ? `, ${where}` : ""}${when ? `, ${when}` : ""}. Ответ в очереди ничего не меняет.`;
      await journalQueue(
        row.workspaceId,
        "approval.late_answer",
        row.id,
        `item ${itemId} choice ${choice}; request ${row.status}`,
        "allowed",
      );
    } else if (row.decidedVia === "ui") {
      note = `Решено в t-boards ${when}: ${word}.`;
    }
  }
  await client.patch("checks", itemId, {
    agentStatus: row.status === "failed" ? "blocked" : "done",
    agentNote: note,
  });
  let version: number | undefined;
  if (!answeredHere && row.status !== "failed") {
    version = (await client.patch("items", itemId, { archived: true })).version;
  }
  await saveItemState(row.id, itemId, { version, synced: row.status });
}
