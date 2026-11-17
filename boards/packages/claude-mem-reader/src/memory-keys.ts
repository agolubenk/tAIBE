// What card memory may be searched by (TB-113): a card id, a card key such as
// TB-108, or an owner-queue item id. Any other word is refused, so the search
// cannot be turned into a free-text search of the owner's memory. The Mac
// proxy has the same forms (deploy/vps/mac/card-memory-db.mjs).

export type MemoryKeyForm = "id" | "key" | "queue";

export const MAX_MEMORY_KEYS = 6;

// An owner-queue item id: the kind letter and a hyphen (d- decision, s-
// server, m- merge, i- inbox, c- check — all 1227 items of 14.11 start so),
// after the product's prefix if it has one («taibe-d-tba-…», itemIdPrefix).
// A plain hyphenated word such as «api-key» or «root-password» does not fit,
// so a holder of the proxy token cannot search for it either (TB-121).
export const QUEUE_ITEM_ID_PATTERN =
  /^(?=.{3,64}$)(?:[a-z][a-z0-9]*-)?[a-z]-[a-z0-9]+(?:-[a-z0-9]+){0,6}$/;

// A board key: the project key (1 to 10 Latin capitals and digits, e.g. «Q»
// of the queue panel or «TB») and the card number. The project keys of both
// workspaces fit it (checked 13.11); a key outside it is not searched.
export const BOARD_KEY_PATTERN = /^[A-Z][A-Z0-9]{0,9}-[0-9]{1,6}$/;

const FORMS: [MemoryKeyForm, RegExp][] = [
  ["id", /^[a-z0-9]{24}$/],
  ["key", BOARD_KEY_PATTERN],
  ["queue", QUEUE_ITEM_ID_PATTERN],
];

export function memoryKeyForm(key: string): MemoryKeyForm | null {
  for (const [form, pattern] of FORMS) if (pattern.test(key)) return form;
  return null;
}
