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

// The owner reads the reason, not the code (product lens r1).
const FAIL_TEXT: Record<string, string> = {
  queue_item_changed:
    "пункт в очереди правил не t-boards, ответ на изменённый текст не принят",
  target_gone: "карточки больше нет или она в другом пространстве",
  target_felled: "карточка срублена",
  card_is_closed: "карточка уже в «Брёвнах», оттуда пути нет",
  card_not_closed: "карточка уже в работе",
  params_mismatch: "параметры заявки не совпали с тем, что вы видели",
  params_missing: "в заявке не хватает параметров",
  label_gone: "метки больше нет",
  label_deleting: "метка удаляется",
  unknown_action: "неизвестное действие",
  http_400: "параметры не подошли карточке",
  http_403: "у владельца пространства нет прав на это действие",
  http_404: "карточки, метки или исполнителя больше нет",
  http_409: "карточка не приняла изменение (конфликт статуса или метки)",
  http_410: "карточка срублена",
  reverted: "изменение откатили миграцией",
};

export function failText(reason: string | null): string {
  if (!reason) return "причина не указана";
  const code = reason.split(":")[0] ?? reason;
  return (
    FAIL_TEXT[code] ?? FAIL_TEXT[reason] ?? "карточка не приняла изменение"
  );
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
  // The owner deleted the item: nothing to show, and a write would bring it
  // back.
  if (row.queueSyncedStatus === "deleted") {
    await saveItemState(row.id, itemId, { synced: `deleted:${row.status}` });
    return;
  }
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
      ? `Не применено: ${failText(row.failReason)}. Карточка не изменилась; агент подаст новую заявку, если действие ещё нужно.`
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
