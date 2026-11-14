import { DEFAULT_PLAN_PRODUCT, itemTag, type RecentCard } from "./plan-types";
import type { QueueDoc } from "./queue-client";

// TB-107: what the owner named in the last 7 days — the inbox text and the
// owner's notes on decisions and checks. Only the owner's fields: an inbox item
// is written by the owner's bot only, note and ownerAt by the owner's answer
// (the queue server refuses both to an agent). The agent's note (agentNote,
// oq_agent_status) is never read: an agent would name its own cards in it and
// the owner's item would show them as the owner's inputs. Merge and server
// items are left out: their notes are command output. The texts are data:
// only card keys and row ids are taken from them.
export const INPUT_DAYS = 7;
export const INPUT_MS = INPUT_DAYS * 24 * 60 * 60 * 1000;
const CARD_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
const ROW_ID = /\bw-[a-z0-9-]+\b/g;
const ANSWERED_KINDS = new Set(["decision", "check"]);

export const inputsRowId = (product: string) =>
  product === DEFAULT_PLAN_PRODUCT ? "w-n-inputs" : `w-${product}-inputs`;

// An input, when it arrived (ms) — the inbox's receivedAt, the answer's
// ownerAt — and the plan product of the answered item (itemProduct); null for
// the inbox and an item without a product in its id.
export type OwnerText = { text: string; at: number; product: string | null };

const text = (value: unknown) => (typeof value === "string" ? value : "");
const time = (value: unknown) =>
  typeof value === "string" ? Date.parse(value) : Number.NaN;

// The plan product of a queue item by its id: d-taibe-…, c-hr-… (hr — the
// default product). The queue product does not tell them apart: both boards'
// items are hr-helper there. null — no product of these in the id.
export function itemProduct(id: string, products: string[]): string | null {
  const tag = /^[a-z]-([a-z0-9]+)-/.exec(id)?.[1];
  return products.find((product) => itemTag(product) === tag) ?? null;
}

export function ownerTexts(
  items: QueueDoc[],
  checks: QueueDoc[],
  products: string[],
  now: Date,
): OwnerText[] {
  const since = now.getTime() - INPUT_MS;
  const fresh = (at: number) => Number.isFinite(at) && at >= since;
  const itemOf = new Map(items.map((item) => [item.id, item.data]));
  const texts: OwnerText[] = [];
  for (const item of items) {
    const inbox = item.data.inbox as Record<string, unknown> | undefined;
    const at = time(inbox?.receivedAt);
    if (item.data.kind !== "inbox" || !fresh(at)) continue;
    texts.push({ text: text(inbox?.text), at, product: null });
  }
  for (const check of checks) {
    const at = time(check.data.ownerAt);
    if (!ANSWERED_KINDS.has(String(itemOf.get(check.id)?.kind)) || !fresh(at)) {
      continue;
    }
    texts.push({
      text: text(check.data.note),
      at,
      product: itemProduct(check.id, products),
    });
  }
  return texts.filter((one) => one.text);
}

export type Named = {
  // Card key (upper case) or row id → when it was last named (ms).
  keys: Map<string, number>;
  rows: Map<string, number>;
  // Plan product → card key → when a text of that product named it.
  byProduct: Map<string, Map<string, number>>;
};

const latest = (map: Map<string, number>, id: string, at: number) =>
  map.set(id, Math.max(map.get(id) ?? at, at));

// Card keys and row ids named in the texts, each once, in the order named.
export function namedIn(texts: OwnerText[]): Named {
  const named: Named = {
    keys: new Map(),
    rows: new Map(),
    byProduct: new Map(),
  };
  for (const { text: one, at, product } of texts) {
    const own = product ? (named.byProduct.get(product) ?? new Map()) : null;
    if (product && own) named.byProduct.set(product, own);
    for (const match of one.match(CARD_KEY) ?? []) {
      latest(named.keys, match, at);
      if (own) latest(own, match, at);
    }
    for (const match of one.match(ROW_ID) ?? []) latest(named.rows, match, at);
  }
  return named;
}

// The keys on the cards of 2+ products: the slugs OPS and IDEA are in both
// Lavaeon and aiBoards&eval.
export function sharedKeys(cards: RecentCard[]): Set<string> {
  const products = new Map<string, Set<string>>();
  for (const card of cards) {
    products.set(
      card.key,
      (products.get(card.key) ?? new Set()).add(card.product),
    );
  }
  return new Set(
    [...products].filter(([, of]) => of.size > 1).map(([key]) => key),
  );
}

// When the owner named this product's card. A shared key counts only from a
// text on this product's item: the owner who names OPS-67 on a d-taibe-… item
// means the tAIBE card, and the inbox names no product.
export function namedAt(
  named: Named,
  shared: ReadonlySet<string>,
  product: string,
  key: string,
): number | undefined {
  return shared.has(key)
    ? named.byProduct.get(product)?.get(key)
    : named.keys.get(key);
}
