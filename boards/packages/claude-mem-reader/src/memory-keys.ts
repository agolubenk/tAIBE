// What card memory may be searched by (TB-113): a card id, a card key such as
// TB-108, or an owner-queue item id. Any other word is refused, so the search
// cannot be turned into a free-text search of the owner's memory. The Mac
// proxy has the same forms (deploy/vps/mac/card-memory-db.mjs).

export type MemoryKeyForm = "id" | "key" | "queue";

export const MAX_MEMORY_KEYS = 6;

export const QUEUE_ITEM_ID_PATTERN =
  /^(?=.{3,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+){1,7}$/;

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

// The product boundary (R-002, TB-58): a card reads only the claude-mem
// projects of its product — a root, the repo folder («tAIBE»), and its
// worktrees («tAIBE/<topic>»). A root has no slash. The Mac proxy has the
// same form and limit (deploy/vps/mac/card-memory-db.mjs).
export const MAX_MEMORY_PROJECTS = 4;

export const MEMORY_PROJECT_ROOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isMemoryProjectRoot(root: string): boolean {
  return MEMORY_PROJECT_ROOT_PATTERN.test(root);
}
