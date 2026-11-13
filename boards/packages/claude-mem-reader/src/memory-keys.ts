// What card memory may be searched by (TB-113): a card id, a card key such as
// TB-108, or an owner-queue item id. Any other word is refused, so the search
// cannot be turned into a free-text search of the owner's memory. The Mac
// proxy has the same forms (deploy/vps/mac/card-memory-db.mjs).

export type MemoryKeyForm = "id" | "key" | "queue";

export const MAX_MEMORY_KEYS = 6;

export const QUEUE_ITEM_ID_PATTERN =
  /^(?=.{3,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+){1,7}$/;

const FORMS: [MemoryKeyForm, RegExp][] = [
  ["id", /^[a-z0-9]{24}$/],
  ["key", /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$/],
  ["queue", QUEUE_ITEM_ID_PATTERN],
];

export function memoryKeyForm(key: string): MemoryKeyForm | null {
  for (const [form, pattern] of FORMS) if (pattern.test(key)) return form;
  return null;
}
