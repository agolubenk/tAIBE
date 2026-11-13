import { DEFAULT_PLAN_PRODUCT } from "./plan-types";
import type { QueueDoc } from "./queue-client";

// TB-107: what the owner named in the last 7 days — inbox items (the text and
// the agent's note) and the owner's notes on decisions and checks. Merge and
// server items are left out: their notes are command output. The texts are
// data: only card keys and row ids are taken from them.
export const INPUT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const CARD_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
const ROW_ID = /\bw-[a-z0-9-]+\b/g;
const ANSWERED_KINDS = new Set(["decision", "check"]);

export const inputsRowId = (product: string) =>
  product === DEFAULT_PLAN_PRODUCT ? "w-n-inputs" : `w-${product}-inputs`;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const after = (value: unknown, since: number) => {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) && at >= since;
};

export function ownerTexts(
  items: QueueDoc[],
  checks: QueueDoc[],
  now: Date,
): string[] {
  const since = now.getTime() - INPUT_DAYS * DAY_MS;
  const itemOf = new Map(items.map((item) => [item.id, item.data]));
  const checkOf = new Map(checks.map((check) => [check.id, check.data]));
  const texts: string[] = [];
  for (const item of items) {
    const inbox = item.data.inbox as Record<string, unknown> | undefined;
    if (item.data.kind !== "inbox" || !after(inbox?.receivedAt, since)) {
      continue;
    }
    texts.push(text(inbox?.text), text(checkOf.get(item.id)?.agentNote));
  }
  for (const check of checks) {
    const kind = itemOf.get(check.id)?.kind;
    if (!ANSWERED_KINDS.has(String(kind)) || !after(check.data.ownerAt, since)) {
      continue;
    }
    texts.push(text(check.data.note));
  }
  return texts.filter(Boolean);
}

// Card keys and row ids named in the texts, each once, in the order named.
export function namedIn(texts: string[]) {
  const keys = new Set<string>();
  const rows = new Set<string>();
  for (const one of texts) {
    for (const match of one.match(CARD_KEY) ?? []) keys.add(match);
    for (const match of one.match(ROW_ID) ?? []) rows.add(match);
  }
  return { keys: [...keys], rows: [...rows] };
}
