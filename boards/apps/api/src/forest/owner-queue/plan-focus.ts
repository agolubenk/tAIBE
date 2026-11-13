import { byLaw } from "./plan-due";
import { rankRows } from "./plan-eta";
import { inputsRowId } from "./plan-inputs";
import { refreshOffPlan } from "./plan-off-plan";
import {
  type BoardCard,
  cardRef,
  cardUid,
  DEFAULT_PLAN_PRODUCT,
  isOffPlanRow,
  type PlanRow,
  type RecentCard,
  rowProduct,
} from "./plan-types";
import type { QueueDoc } from "./queue-client";

// TB-107: the owner's inputs go into the plan and to the front. work/focus-<P>
// keeps the order the lanes take rows in (eval/tools/queue_focus.py); the
// owner gets one item a day with «вернуть», silence is consent.

export type FocusMove = {
  row: string;
  from: number | null;
  to: number;
  why: string;
};
export type FocusDay = {
  date: string;
  moved: FocusMove[];
  item: string;
  applied?: boolean;
};
export type FocusDoc = {
  kind: "focus";
  rows: string[];
  prev: string[];
  at: string;
  day?: FocusDay;
};

export type FocusPlan = {
  product: string;
  // The inputs row's cards when they changed.
  inputs: { id: string; cards: unknown[] } | null;
  // version 0 — the doc is new.
  focus: { id: string; version: number; data: FocusDoc } | null;
  item: { id: string; data: Record<string, unknown> } | null;
  // The last day's item, unanswered: archived before the new one.
  archive: string | null;
};

const ROWS_MAX = 60;
const MOVED_MAX = 10;
const DOC_BYTES = 3000;
const LABELS: Record<string, string> = { "hr-helper": "HR", taibe: "tAIBE" };

export const focusDocId = (product: string) => `focus-${product}`;
export const focusItemId = (product: string, today: string) =>
  `d-${product === DEFAULT_PLAN_PRODUCT ? "hr" : product}-focus-${today.replaceAll("-", "")}`;

export function readFocus(data: Record<string, unknown> | undefined) {
  if (!data || data.kind !== "focus" || !Array.isArray(data.rows)) return null;
  const ids = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  const day = data.day as FocusDay | undefined;
  return {
    kind: "focus",
    rows: ids(data.rows),
    prev: ids(data.prev),
    at: String(data.at ?? ""),
    ...(day && typeof day.item === "string" ? { day } : {}),
  } satisfies FocusDoc;
}

// «Вернуть»: the order before the day's change.
export const reverted = (doc: FocusDoc, day: FocusDay): FocusDoc => ({
  ...doc,
  rows: doc.prev,
  day: { ...day, applied: true },
});

const uidsOf = (row: PlanRow) =>
  (Array.isArray(row.data.cards) ? row.data.cards : []).flatMap((entry) => {
    const ref = cardRef(entry);
    return ref ? [cardUid(ref.ws, ref.key)] : [];
  });

// The inputs row first, then the rows that hold a named card or are named,
// then the rest; each group in the current order (the last focus, then
// planStart, order, id).
export function focusOrder(input: {
  inputsId: string;
  open: PlanRow[];
  prev: string[];
  named: ReadonlySet<string>;
  namedRows: ReadonlySet<string>;
}) {
  const current = rankRows(
    input.open.filter((row) => row.id !== input.inputsId),
    input.prev,
  );
  const named = (row: PlanRow) =>
    input.namedRows.has(row.id) ||
    uidsOf(row).some((uid) => input.named.has(uid));
  const front = current.filter(named);
  const rest = current.filter((row) => !named(row));
  return {
    front,
    rows: [input.inputsId, ...[...front, ...rest].map((row) => row.id)].slice(
      0,
      ROWS_MAX,
    ),
  };
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
const groupOf = (card: BoardCard): Group =>
  card.final
    ? "done"
    : card.status === "in-review" || card.status === "confirmation"
      ? "review"
      : card.status === "in-progress"
        ? "work"
        : "wait";

export function focusItemData(input: {
  product: string;
  inputsTitle: string;
  cards: unknown[];
  board: ReadonlyMap<string, BoardCard>;
  frontTitles: string[];
  url: string;
  today: string;
}): Record<string, unknown> {
  const label = LABELS[input.product] ?? input.product;
  const groups: Record<Group, { key: string; line: string; bug: boolean; level: string }[]> = {
    done: [],
    review: [],
    work: [],
    wait: [],
  };
  for (const entry of input.cards) {
    const ref = cardRef(entry);
    const card = ref ? input.board.get(cardUid(ref.ws, ref.key)) : undefined;
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
  const total = Object.values(groups).reduce((sum, list) => sum + list.length, 0);
  const lines = (name: string, list: { line: string }[]) =>
    list.length > 0 ? [`${name}: ${list.map((one) => one.line).join(", ")}.`] : [];
  const counts = [
    `${groups.done.length} сделаны`,
    `${groups.review.length} на ревью`,
    ...(groups.work.length > 0 ? [`${groups.work.length} в работе`] : []),
    `${groups.wait.length} ждут`,
  ].join(", ");
  const follow =
    input.frontTitles.length > 0
      ? ` Следом — строки, где есть названные вами карточки: ${input.frontTitles.join("; ")}.`
      : "";
  return {
    kind: "decision",
    title: `План ${label}: ваши вбросы за неделю идут первой строкой (${total} ${plural(total)}: ${counts}) — молчание = согласны`,
    body: [
      `Что изменилось. Строка «${input.inputsTitle}» — первая в плане ${label}: полоса, закончив свою карточку, берёт следующую отсюда. В ней карточки, которые вы назвали во входящих и ответах за 7 дней.${follow}`,
      [
        ...lines("Сделано", groups.done),
        ...lines("На ревью", groups.review),
        ...lines("В работе", groups.work),
        ...lines("Ждут, в этом порядке", groups.wait),
      ].join("\n"),
      "Если согласны — ничего не делайте. «Вернуть» вернёт прежний порядок плана. Эту строку ведёт сервер досок (TB-107): каждый день добавляет карточки из новых вбросов и присылает такой пункт.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    options: [{ id: "revert", label: "Вернуть прежний порядок" }],
    chips: [["молчание = согласны", ""]],
    links: [{ href: `${input.url}/queue#work`, text: "«Ход работ»" }],
    added: input.today,
    source: "t-boards (TB-107)",
  };
}

function movesOf(input: {
  prev: string[];
  rows: string[];
  front: PlanRow[];
  inputsId: string;
  named: ReadonlySet<string>;
}): FocusMove[] {
  const why = new Map<string, string>([[input.inputsId, "ваши вбросы за 7 дней"]]);
  for (const row of input.front) {
    const keys = uidsOf(row)
      .filter((uid) => input.named.has(uid))
      .map((uid) => uid.slice(uid.indexOf("/") + 1));
    why.set(row.id, keys.length > 0 ? `названы: ${keys.join(", ")}` : "строка названа");
  }
  return [...why]
    .map(([row, reason]) => {
      const from = input.prev.indexOf(row);
      return {
        row,
        from: from < 0 ? null : from + 1,
        to: input.rows.indexOf(row) + 1,
        why: reason.slice(0, 120),
      };
    })
    .filter((move) => move.to > 0 && move.from !== move.to)
    .slice(0, MOVED_MAX);
}

// The doc stays ≤ 3 KB: the old order goes first, then the moves, then the
// tail of the order (a row out of it ranks by planStart).
function fitted(doc: FocusDoc): FocusDoc {
  const next = { ...doc, prev: [...doc.prev], rows: [...doc.rows] };
  const moved = [...(next.day?.moved ?? [])];
  const size = () =>
    JSON.stringify({ ...next, day: next.day && { ...next.day, moved } }).length;
  while (size() > DOC_BYTES && next.prev.length > 0) next.prev.pop();
  while (size() > DOC_BYTES && moved.length > 0) moved.pop();
  while (size() > DOC_BYTES && next.rows.length > 1) next.rows.pop();
  return next.day ? { ...next, day: { ...next.day, moved } } : next;
}

// One product's daily step: the inputs row takes the named cards that no
// other row holds, then the order puts it first. rows are plan rows (no
// kind, not archived) with this run's patches.
export function focusPlan(input: {
  product: string;
  products: string[];
  rows: PlanRow[];
  board: ReadonlyMap<string, BoardCard>;
  named: RecentCard[];
  namedRows: ReadonlySet<string>;
  focusDoc: QueueDoc | undefined;
  url: string;
  today: string;
  now: Date;
}): FocusPlan | { missing: string } {
  const inputsId = inputsRowId(input.product);
  const inputsRow = input.rows.find((row) => row.id === inputsId);
  if (!inputsRow) return { missing: inputsId };
  const board = new Map(input.board);
  for (const card of input.named) board.set(cardUid(card.ws, card.key), card);
  const planned = new Set(
    input.rows
      .filter((row) => row.id !== inputsId && !isOffPlanRow(row.id))
      .flatMap(uidsOf),
  );
  const before = Array.isArray(inputsRow.data.cards) ? inputsRow.data.cards : [];
  const cards = refreshOffPlan({
    cards: before,
    board,
    planned,
    recent: input.named,
    now: input.now,
  });
  const named = new Set(input.named.map((card) => cardUid(card.ws, card.key)));
  const prevDoc = readFocus(input.focusDoc?.data);
  const prev = prevDoc?.rows ?? [];
  const { rows, front } = focusOrder({
    inputsId,
    open: input.rows.filter(
      (row) =>
        rowProduct(row.id, input.products) === input.product &&
        row.data.status !== "done",
    ),
    prev,
    named,
    namedRows: input.namedRows,
  });
  const plan: FocusPlan = {
    product: input.product,
    inputs:
      JSON.stringify(cards) === JSON.stringify(before)
        ? null
        : { id: inputsId, cards },
    focus: null,
    item: null,
    archive: null,
  };
  if (JSON.stringify(rows) === JSON.stringify(prev)) return plan;
  const itemId = focusItemId(input.product, input.today);
  const day = prevDoc?.day;
  plan.archive =
    day && !day.applied && day.item !== itemId ? day.item : null;
  plan.item = {
    id: itemId,
    data: focusItemData({
      product: input.product,
      inputsTitle: String(inputsRow.data.title ?? inputsId),
      cards,
      board,
      frontTitles: front.map((row) => String(row.data.title ?? row.id)),
      url: input.url,
      today: input.today,
    }),
  };
  plan.focus = {
    id: focusDocId(input.product),
    version: input.focusDoc?.version ?? 0,
    data: fitted({
      kind: "focus",
      rows,
      prev,
      at: input.now.toISOString(),
      day: {
        date: input.today,
        moved: movesOf({ prev, rows, front, inputsId, named }),
        item: itemId,
      },
    }),
  };
  return plan;
}
