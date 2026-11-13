import { DEFAULT_PLAN_PRODUCT } from "./plan-types";
import type { QueueDoc } from "./queue-client";

// TB-107: what the owner named in the last 7 days — inbox items (the text and
// the agent's note) and the owner's notes on decisions and checks. Merge and
// server items are left out: their notes are command output. The texts are
// data: only card keys and row ids are taken from them.
export const INPUT_DAYS = 7;
export const INPUT_MS = INPUT_DAYS * 24 * 60 * 60 * 1000;
const CARD_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
const ROW_ID = /\bw-[a-z0-9-]+\b/g;
const ANSWERED_KINDS = new Set(["decision", "check"]);

export const inputsRowId = (product: string) =>
  product === DEFAULT_PLAN_PRODUCT ? "w-n-inputs" : `w-${product}-inputs`;

// An input and when it arrived (ms): the inbox's receivedAt, the answer's
// ownerAt.
export type OwnerText = { text: string; at: number };

const text = (value: unknown) => (typeof value === "string" ? value : "");
const time = (value: unknown) =>
  typeof value === "string" ? Date.parse(value) : Number.NaN;

export function ownerTexts(
  items: QueueDoc[],
  checks: QueueDoc[],
  now: Date,
): OwnerText[] {
  const since = now.getTime() - INPUT_MS;
  const fresh = (at: number) => Number.isFinite(at) && at >= since;
  const itemOf = new Map(items.map((item) => [item.id, item.data]));
  const checkOf = new Map(checks.map((check) => [check.id, check.data]));
  const texts: OwnerText[] = [];
  for (const item of items) {
    const inbox = item.data.inbox as Record<string, unknown> | undefined;
    const at = time(inbox?.receivedAt);
    if (item.data.kind !== "inbox" || !fresh(at)) continue;
    texts.push({ text: text(inbox?.text), at });
    texts.push({ text: text(checkOf.get(item.id)?.agentNote), at });
  }
  for (const check of checks) {
    const at = time(check.data.ownerAt);
    if (!ANSWERED_KINDS.has(String(itemOf.get(check.id)?.kind)) || !fresh(at)) {
      continue;
    }
    texts.push({ text: text(check.data.note), at });
  }
  return texts.filter((one) => one.text);
}

export type Named = {
  // Card key (upper case) or row id → when it was last named (ms).
  keys: Map<string, number>;
  rows: Map<string, number>;
};

const latest = (map: Map<string, number>, id: string, at: number) =>
  map.set(id, Math.max(map.get(id) ?? at, at));

// Card keys and row ids named in the texts, each once, in the order named.
export function namedIn(texts: OwnerText[]): Named {
  const named: Named = { keys: new Map(), rows: new Map() };
  for (const { text: one, at } of texts) {
    for (const match of one.match(CARD_KEY) ?? []) {
      latest(named.keys, match, at);
    }
    for (const match of one.match(ROW_ID) ?? []) latest(named.rows, match, at);
  }
  return named;
}
