import { byLaw } from "./plan-due";
import {
  type BoardCard,
  cardRef,
  cardUid,
  DEFAULT_PLAN_PRODUCT,
} from "./plan-types";

// TB-107: the owner's item of a day with a move, after the 13.11 one
// (d-hr-focus-1311): counts in the title, the cards by state, one option
// «revert», silence is consent.

const LABELS: Record<string, string> = { "hr-helper": "HR", taibe: "tAIBE" };

export const focusItemId = (product: string, today: string) =>
  `d-${product === DEFAULT_PLAN_PRODUCT ? "hr" : product}-focus-${today.replaceAll("-", "")}`;

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
    source: "t-boards (TB-107)",
  };
}
