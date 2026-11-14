import { byLaw } from "./plan-due";
import { type BoardCard, cardRef, cardUid, itemTag } from "./plan-types";
import type { QueueDoc } from "./queue-client";

// TB-107: the owner's item of a day with a move, after the 13.11 one
// (d-hr-focus-1311): counts in the title, the cards by state, one option
// «revert», silence is consent. The item is the source of truth, as the due
// decision of TB-112: what «Вернуть» restores is the order the item offered
// (focus), and when the owner reverted is the ownerAt of the owner's answer.
// work/focus-<P> (the agents write the work collection) only points to the
// day's item and keeps the order the lanes take rows in.

const LABELS: Record<string, string> = { "hr-helper": "HR", taibe: "tAIBE" };

export const FOCUS_SOURCE = "t-boards (TB-107)";
// Every focus decision of the product starts so, the hand-filed one too.
const focusItemPrefix = (product: string) => `d-${itemTag(product)}-focus-`;
export const focusItemId = (product: string, today: string) =>
  `${focusItemPrefix(product)}${today.replaceAll("-", "")}`;

// The day's order as the item offered it: rows — the new order, prev — the
// order before it (what «Вернуть» restores), keys — the named cards that moved
// the rows.
export type ItemFocus = { rows: string[]; prev: string[]; keys: string[] };

// A focus decision of this product. The owner's «Вернуть» on it stops the
// same inputs (d-hr-focus-1311, filed by hand on 13.11, counts too): an agent
// can file such an item, but only the owner's answer sets choice and ownerAt.
export function isFocusItem(
  item: QueueDoc | null | undefined,
  product: string,
): item is QueueDoc {
  return (
    !!item &&
    item.id.startsWith(focusItemPrefix(product)) &&
    item.data.kind === "decision"
  );
}

const strings = (value: unknown) =>
  Array.isArray(value) && value.every((one) => typeof one === "string")
    ? (value as string[])
    : null;

// What a focus item of this server offered; null — not ours, or broken.
export function readItemFocus(
  item: QueueDoc | null | undefined,
  product: string,
): ItemFocus | null {
  if (!isFocusItem(item, product) || item.data.source !== FOCUS_SOURCE) {
    return null;
  }
  const focus = item.data.focus as Record<string, unknown> | undefined;
  const rows = strings(focus?.rows);
  const prev = strings(focus?.prev);
  const keys = strings(focus?.keys);
  return rows && prev && keys ? { rows, prev, keys } : null;
}

const short = (title: unknown) => {
  const clean = String(title ?? "").replace(/^(Ошибка|Задача):\s*/u, "");
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
};

const plural = (count: number) => {
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return "карточка";
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return "карточки";
  return "карточек";
};

type Group = "done" | "review" | "work" | "wait";
type Line = { key: string; line: string; bug: boolean; level: string };

const groupOf = (card: BoardCard): Group =>
  card.final
    ? "done"
    : card.status === "in-review" || card.status === "confirmation"
      ? "review"
      : card.status === "in-progress"
        ? "work"
        : "wait";

function grouped(cards: unknown[], board: ReadonlyMap<string, BoardCard>) {
  const groups: Record<Group, Line[]> = {
    done: [],
    review: [],
    work: [],
    wait: [],
  };
  for (const entry of cards) {
    const ref = cardRef(entry);
    const card = ref ? board.get(cardUid(ref.ws, ref.key)) : undefined;
    if (!ref || !card) continue;
    const fields = entry as Record<string, unknown>;
    groups[groupOf(card)].push({
      key: ref.key,
      line: `${ref.key} (${short(fields.t)})`,
      bug: fields.k === "bug",
      level: typeof fields.s === "string" ? fields.s : "",
    });
  }
  groups.wait.sort(byLaw);
  return groups;
}

export function focusItemData(input: {
  product: string;
  inputsTitle: string;
  // The inputs row is first (not after a «вернуть» without its new cards).
  inputsFirst: boolean;
  cards: unknown[];
  board: ReadonlyMap<string, BoardCard>;
  frontTitles: string[];
  url: string;
  today: string;
  offered: ItemFocus;
}): Record<string, unknown> {
  const label = LABELS[input.product] ?? input.product;
  const groups = grouped(input.cards, input.board);
  const total = Object.values(groups).reduce(
    (sum, list) => sum + list.length,
    0,
  );
  const lines = (name: string, list: Line[]) =>
    list.length > 0
      ? [`${name}: ${list.map((one) => one.line).join(", ")}.`]
      : [];
  const counts = [
    `${groups.done.length} сделаны`,
    `${groups.review.length} на ревью`,
    ...(groups.work.length > 0 ? [`${groups.work.length} в работе`] : []),
    `${groups.wait.length} ждут`,
  ].join(", ");
  const lead = input.inputsFirst
    ? `Строка «${input.inputsTitle}» — первая в плане ${label}: полоса, закончив свою карточку, берёт следующую отсюда. В ней карточки, которые вы назвали во входящих и ответах за 7 дней.`
    : `Строка «${input.inputsTitle}» собирает карточки, которые вы назвали во входящих и ответах за 7 дней.`;
  const follow =
    input.frontTitles.length > 0
      ? ` Вперёд плана ${label} — строки с карточками из ваших новых вбросов: ${input.frontTitles.join("; ")}.`
      : "";
  return {
    kind: "decision",
    title: `План ${label}: ваши вбросы за неделю — вперёд (${total} ${plural(total)}: ${counts}) — молчание = согласны`,
    body: [
      `Что изменилось. ${lead}${follow}`,
      [
        ...lines("Сделано", groups.done),
        ...lines("На ревью", groups.review),
        ...lines("В работе", groups.work),
        ...lines("Ждут, в этом порядке", groups.wait),
      ].join("\n"),
      "Если согласны — ничего не делайте. «Вернуть» вернёт прежний порядок плана; те же вбросы его больше не сдвинут, только новые. Строку вбросов ведёт сервер досок (TB-107): каждый день добавляет карточки из новых вбросов.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    options: [{ id: "revert", label: "Вернуть прежний порядок" }],
    chips: [["молчание = согласны", ""]],
    links: [{ href: `${input.url}/queue#work`, text: "«Ход работ»" }],
    added: input.today,
    source: FOCUS_SOURCE,
    focus: input.offered,
  };
}
