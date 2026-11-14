import { answeredAfter, archiveItem } from "./plan-due-apply";
import {
  type FocusPlan,
  focusDocId,
  focusPlan,
  readFocus,
  revertedDoc,
} from "./plan-focus";
import { isFocusItem, readItemFocus } from "./plan-focus-item";
import {
  INPUT_MS,
  type Named,
  namedIn,
  ownerTexts,
  sharedKeys,
} from "./plan-inputs";
import type { RowWrite } from "./plan-rows";
import {
  type BoardCard,
  type PlanRow,
  type RecentCard,
  rowProduct,
} from "./plan-types";
import type { PlanWriter } from "./plan-writer";
import { listAll, type QueueClient, type QueueDoc } from "./queue-client";

// What one product's open day decides: null — the owner has not answered
// (nothing to do yet); a revert — the item to restore from (offered null:
// nothing to restore, the day only closes).
async function dayAnswer(writer: PlanWriter, itemId: string, product: string) {
  const item = await writer.client.get("items", itemId);
  const archived = item?.data.archived === true;
  const offered = archived ? null : readItemFocus(item, product);
  if (!item || !offered) return { item: null, offered: null };
  const check = await writer.client.get("checks", item.id);
  if (check?.data.choice !== "revert") return null;
  // The item changed after the answer: the owner did not see this order.
  return { item, offered: answeredAfter(check, item) ? offered : null };
}

// TB-107, every run: the owner's «Вернуть» on the day's focus item is applied
// once, then the item is archived. Everything it restores comes from the item
// the owner answered, never from the doc: the doc only points to the item. A
// doc that points to a missing or archived item, or to one that is not a
// focus item of this server (the 13.11 one filed by hand), restores nothing
// and only closes the day. Returns whether a doc changed.
export async function applyReverts(
  writer: PlanWriter,
  docs: QueueDoc[],
  rows: PlanRow[],
  products: string[],
) {
  const before = writer.written;
  for (const product of products) {
    const doc = docs.find((one) => one.id === focusDocId(product));
    const focus = readFocus(doc?.data);
    const day = focus?.day;
    if (!doc || !focus || !day || day.applied) continue;
    const answer = await dayAnswer(writer, day.item, product);
    if (!answer) continue;
    const own = new Set(
      rows
        .filter((row) => rowProduct(row.id, products) === product)
        .map((row) => row.id),
    );
    const put = await writer.write(() =>
      writer.client.put(
        "work",
        doc.id,
        revertedDoc(focus, day, answer.offered, own),
        doc.version,
      ),
    );
    if (answer.item && typeof put !== "string") {
      await archiveItem(writer, answer.item.id);
    }
  }
  return writer.written > before;
}

// When the owner last pressed «Вернуть» on a focus item of each product, in
// the last 7 days (ms). Only the owner's answer sets choice and ownerAt (the
// queue server), so an agent can neither start nor move this window; the item
// is archived after the revert and still counts. An answer on an item changed
// after it restores nothing but still stops the older inputs: fewer moves,
// never more.
export function ownerReverts(
  items: QueueDoc[],
  checks: QueueDoc[],
  products: string[],
  now: Date,
): Map<string, number> {
  const since = now.getTime() - INPUT_MS;
  const itemOf = new Map(items.map((item) => [item.id, item]));
  const reverts = new Map<string, number>();
  for (const check of checks) {
    if (check.data.choice !== "revert") continue;
    const at =
      typeof check.data.ownerAt === "string"
        ? Date.parse(check.data.ownerAt)
        : Number.NaN;
    if (!Number.isFinite(at) || at < since) continue;
    const item = itemOf.get(check.id);
    const product = products.find((one) => isFocusItem(item, one));
    if (product) reverts.set(product, Math.max(reverts.get(product) ?? at, at));
  }
  return reverts;
}

// Read once a day: items and checks are the largest collections of the
// queue. truncated — a list was cut: an owner's revert may be missing.
export async function readOwnerInputs(
  client: QueueClient,
  products: string[],
  now: Date,
  deadline: number,
) {
  const [items, checks] = await Promise.all([
    listAll(client, "items", deadline),
    listAll(client, "checks", deadline),
  ]);
  return {
    named: namedIn(ownerTexts(items.docs, checks.docs, products, now)),
    reverts: ownerReverts(items.docs, checks.docs, products, now),
    truncated: items.truncated || checks.truncated,
  };
}

// Every product's daily step; a product without its inputs row is logged.
export function focusPlans(input: {
  docs: QueueDoc[];
  rows: PlanRow[];
  board: ReadonlyMap<string, BoardCard>;
  cards: RecentCard[];
  named: Named;
  reverts: ReadonlyMap<string, number>;
  products: string[];
  url: string;
  today: string;
  now: Date;
}): FocusPlan[] {
  const plans: FocusPlan[] = [];
  const missing: string[] = [];
  // A shared key named only where no product is said (the inbox) moves no
  // card: the owner names it on the product's item.
  const unsaid = [...sharedKeys(input.cards)].filter(
    (key) =>
      input.named.keys.has(key) &&
      ![...input.named.byProduct.values()].some((keys) => keys.has(key)),
  );
  if (unsaid.length > 0) {
    console.warn(
      `owner-queue plan focus: ${unsaid.join(", ")} is on cards of 2+ products and named without a product; skipped`,
    );
  }
  for (const product of input.products) {
    const plan = focusPlan({
      ...input,
      product,
      revertAt: input.reverts.get(product),
      focusDoc: input.docs.find((doc) => doc.id === focusDocId(product)),
    });
    if ("missing" in plan) missing.push(plan.missing);
    else plans.push(plan);
  }
  if (missing.length > 0) {
    console.warn(
      `owner-queue plan rows: no row ${missing.join(", ")}; the owner's inputs are not planned`,
    );
  }
  return plans;
}

// The inputs row's cards join the row's write of this run: one write per row.
export function withInputs(
  writes: RowWrite[],
  rows: PlanRow[],
  plans: FocusPlan[],
) {
  const byId = new Map(writes.map((write) => [write.id, write]));
  const versions = new Map(rows.map((row) => [row.id, row.version]));
  for (const { inputs } of plans) {
    if (!inputs) continue;
    const write = byId.get(inputs.id);
    if (write) write.patch.cards = inputs.cards;
    else {
      byId.set(inputs.id, {
        id: inputs.id,
        version: versions.get(inputs.id) ?? 0,
        patch: { cards: inputs.cards },
        rank: 3,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.rank - b.rank);
}

// A changed order: the day's item first (409 — it exists: the day was run
// already), then the last unanswered one archived, then the focus doc.
export async function writeFocus(writer: PlanWriter, plans: FocusPlan[]) {
  for (const { item, focus, archive } of plans) {
    if (!item || !focus) continue;
    const put = await writer.write(() =>
      writer.client.put("items", item.id, item.data, 0),
    );
    if (put === "left") continue;
    if (archive) await archiveItem(writer, archive);
    await writer.write(() =>
      writer.client.put("work", focus.id, focus.data, focus.version),
    );
  }
}
