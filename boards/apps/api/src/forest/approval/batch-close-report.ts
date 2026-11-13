export type Skipped = { key: string; reason: string };

// Why a card of a batch was not closed, in the owner's words.
const SKIP_TEXT: Record<string, string> = {
  changed: "изменилась после заявки",
  already_closed: "уже закрыта",
  moved: "перенесена в другой проект",
  leased: "в аренде у сессии",
  half_baked: "сырая идея",
  target_gone: "удалена",
  target_felled: "срублена",
  card_is_closed: "в «Брёвнах»",
};

export function skipText(reason: string): string {
  const code = reason.split(":")[0] ?? reason;
  return SKIP_TEXT[code] ?? "не приняла изменение";
}

const SHOWN = 20;

// The report the queue item shows after «да» (R-3, Пакет А): how many cards
// closed and which were skipped with the reason. The journal keeps a row per
// skipped card, so the text names only the first ones.
export function batchReport(
  closed: number,
  total: number,
  skipped: readonly Skipped[],
): string {
  const head = `закрыто ${closed} из ${total}`;
  if (skipped.length === 0) return `${head}.`;
  const shown = skipped
    .slice(0, SHOWN)
    .map((card) => `${card.key} (${skipText(card.reason)})`)
    .join(", ");
  const more = skipped.length > SHOWN ? ` и ещё ${skipped.length - SHOWN}` : "";
  return `${head}; пропущено ${skipped.length}: ${shown}${more}.`;
}
