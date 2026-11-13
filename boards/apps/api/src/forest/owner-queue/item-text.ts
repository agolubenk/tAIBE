import { randomBytes } from "node:crypto";
import { projectCounts } from "../approval/batch-close-params";
import { itemIdPrefix } from "./queue-config";

export type ItemApproval = {
  id: string;
  action: string;
  params: Record<string, string> | null;
  reason: string | null;
  requestedByName: string;
  expiresAt: Date;
  doneRef: string | null;
  doneReason: string | null;
};

export type ItemCard = {
  key: string;
  title: string;
  current: string | null;
} | null;

const NONCE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// Six server-made characters (F18): an agent cannot know the item id ahead
// and plant its own item under it.
export function itemNonce(): string {
  const bytes = randomBytes(6);
  return [...bytes]
    .map((byte) => NONCE_ALPHABET[byte % NONCE_ALPHABET.length])
    .join("");
}

export function approvalItemId(
  product: string,
  approvalId: string,
  nonce: string,
): string {
  return `${itemIdPrefix(product)}d-tba-${approvalId}-${nonce}`;
}

function batchKeys(approval: ItemApproval): string[] {
  if (approval.action !== "close_task") return [];
  return (approval.params?.keys ?? "").split(",").filter(Boolean);
}

function actionLine(approval: ItemApproval): string {
  const p = approval.params ?? {};
  switch (approval.action) {
    case "close_task":
      return p.taskIds
        ? `закрыть карточки (${batchKeys(approval).length}) → финальная колонка своего проекта`
        : `закрыть карточку → «${p.status ?? "?"}»`;
    case "reopen_task":
      return `вернуть карточку в работу → «${p.status ?? "?"}»`;
    case "set_priority":
      return `приоритет → «${p.priority ?? "?"}»`;
    case "set_assignee":
      return `исполнитель → ${p.userName ?? p.userId ?? "?"}`;
    case "create_label":
      return `создать метку «${p.name ?? "?"}» (${p.color ?? "?"}) на карточках: ${(p.taskIds ?? "").split(",").filter(Boolean).length}`;
    case "attach_label":
      return `поставить метку «${p.labelName ?? "?"}» на карточки: ${(p.taskIds ?? "").split(",").filter(Boolean).length}`;
    case "fell_tree":
      return "срубить дерево (карточки уйдут в журнал и семена)";
    case "fell_sector":
      return "срубить сектор (карточки уйдут в журнал и семена)";
    default:
      return approval.action;
  }
}

// The ops-console takes links as objects {href, text?} (store.ts httpsLink);
// a bare string fails the whole PUT with 422 and stops the sync pass (TB-109).
function itemLinks(doneRef: string | null, listUrl: string | undefined) {
  const links = [
    ...(doneRef ? [{ href: doneRef, text: "Журнал закрытых" }] : []),
    ...(listUrl ? [{ href: listUrl, text: "Список карточек в t-boards" }] : []),
  ];
  return links.length > 0 ? { links } : {};
}

function moscowTime(date: Date): string {
  return `${date.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })} МСК`;
}

// The server writes the whole text (spec «Пункт очереди»): workspace, card,
// action with current → target value, term and done-log ref. The agent's
// reason is a separate paragraph marked as the agent's text.
export function approvalItemData({
  approval,
  workspaceName,
  card,
  taskKeys = [],
  listUrl,
  now,
}: {
  approval: ItemApproval;
  workspaceName: string;
  card: ItemCard;
  // Label grants: the cards that get the label, as «KEY-12 «title»»; a batch
  // close: its first cards.
  taskKeys?: string[];
  // A batch close: the full list in t-boards (TB-108 R-5).
  listUrl?: string;
  now: Date;
}): Record<string, unknown> {
  const action = actionLine(approval);
  const batch = batchKeys(approval);
  const cardLine = card ? `${card.key} «${card.title}»` : "—";
  const title = `t-boards: ${action}${card ? ` — ${card.key}` : ""}`.slice(
    0,
    300,
  );
  const paragraphs = [
    `Пространство: ${workspaceName}`,
    batch.length > 0
      ? `Карточек: ${batch.length} — ${projectCounts(batch)}`
      : `Карточка: ${cardLine}`,
    `Действие: ${action}${card?.current ? ` (сейчас: «${card.current}»)` : ""}`,
    `Срок ответа: до ${moscowTime(approval.expiresAt)}. Просит: ${approval.requestedByName}.`,
  ];
  if (taskKeys.length > 0) {
    const more = batch.length - taskKeys.length;
    paragraphs.push(
      `${batch.length > 0 ? "Первые карточки" : "Карточки"}:\n${taskKeys.map((key) => `- ${key}`).join("\n")}${more > 0 ? `\n- и ещё ${more}` : ""}`,
    );
  }
  if (batch.length > 0) {
    paragraphs.push(
      "Карточка, которая изменится после заявки, будет в аренде или уже закрыта, не закрывается — после «Да» здесь появится отчёт: сколько закрыто и что пропущено.",
    );
    if (listUrl) paragraphs.push(`Полный список: ${listUrl}`);
  }
  if (approval.doneRef) paragraphs.push(`Журнал закрытых: ${approval.doneRef}`);
  if (approval.doneReason) {
    paragraphs.push(`Без записи в журнале закрытых: ${approval.doneReason}`);
  }
  if (approval.reason) {
    paragraphs.push(`Текст агента:\n${approval.reason.slice(0, 4000)}`);
  }
  paragraphs.push(
    "«Да» — t-boards применит действие сам. Статус этого пункта ведёт только t-boards.",
  );
  return {
    kind: "decision",
    title,
    body: paragraphs.join("\n\n"),
    options: [
      { id: "yes", label: "Да" },
      { id: "no", label: "Нет" },
    ],
    added: now.toISOString().slice(0, 10),
    source: "t-boards",
    ...itemLinks(approval.doneRef, batch.length > 0 ? listUrl : undefined),
  };
}
