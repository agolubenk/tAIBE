import { archiveItem } from "./plan-due-apply";
import {
  type FocusPlan,
  focusDocId,
  focusPlan,
  readFocus,
  revertedDoc,
} from "./plan-focus";
import { type Named, namedIn, ownerTexts } from "./plan-inputs";
import type { RowWrite } from "./plan-rows";
import type { BoardCard, PlanRow, RecentCard } from "./plan-types";
import type { PlanWriter } from "./plan-writer";
import { listAll, type QueueClient, type QueueDoc } from "./queue-client";

// TB-107, every run: the owner's «Вернуть» on the day's focus item is applied
// once (the item already reverted by hand is only marked), then the item is
// archived. Returns whether a doc changed.
export async function applyReverts(
  writer: PlanWriter,
  docs: QueueDoc[],
  products: string[],
  now: Date,
) {
  const before = writer.written;
  for (const product of products) {
    const doc = docs.find((one) => one.id === focusDocId(product));
    const focus = readFocus(doc?.data);
    const day = focus?.day;
    if (!doc || !focus || !day || day.applied) continue;
    if (focus.reverted?.item === day.item) continue;
    const check = await writer.client.get("checks", day.item);
    if (check?.data.choice !== "revert") continue;
    const at = [check.data.ownerAt, check.data.at].find(
      (value): value is string =>
        typeof value === "string" && Number.isFinite(Date.parse(value)),
    );
    const put = await writer.write(() =>
      writer.client.put(
        "work",
        doc.id,
        { ...doc.data, ...revertedDoc(focus, day, at ?? now.toISOString()) },
        doc.version,
      ),
    );
    if (typeof put !== "string") await archiveItem(writer, day.item);
  }
  return writer.written > before;
}

// The texts are read once a day: items and checks are the largest
// collections of the queue.
export async function readNamed(client: QueueClient, now: Date) {
  const [items, checks] = await Promise.all([
    listAll(client, "items"),
    listAll(client, "checks"),
  ]);
  return namedIn(ownerTexts(items.docs, checks.docs, now));
}

// Every product's daily step; a product without its inputs row is logged.
export function focusPlans(input: {
  docs: QueueDoc[];
  rows: PlanRow[];
  board: ReadonlyMap<string, BoardCard>;
  cards: RecentCard[];
  named: Named;
  products: string[];
  url: string;
  today: string;
  now: Date;
}): FocusPlan[] {
  const plans: FocusPlan[] = [];
  const missing: string[] = [];
  for (const product of input.products) {
    const plan = focusPlan({
      ...input,
      product,
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
