import { archiveItem, applyAnswers } from "./plan-due-apply";
import { type DailyPlan, dailyPlan } from "./plan-due-daily";
import { PACE_DAYS } from "./plan-eta";
import {
  applyReverts,
  focusPlans,
  readNamed,
  withInputs,
  writeFocus,
} from "./plan-focus-run";
import type { FocusPlan } from "./plan-focus";
import { planWrites, type RowWrite } from "./plan-rows";
import {
  type BoardCard,
  type CardRef,
  cardRef,
  localDate,
  offPlanSince,
  type PlanRow,
  type RecentCard,
  withPatch,
} from "./plan-types";
import { PlanWriter } from "./plan-writer";
import { listAll, type QueueClient, type QueueDoc } from "./queue-client";
import type { OwnerQueueConfig } from "./queue-config";

export { PLAN_WRITES_PER_RUN } from "./plan-writer";

// The board side of a run (plan-store.ts); tests use an in-memory one. Every
// read stays inside the workspaces mapped to a product.
export interface PlanStore {
  resolve(
    workspaceIds: string[],
    refs: CardRef[],
  ): Promise<Map<string, BoardCard>>;
  recent(products: Map<string, string>, since: Date): Promise<RecentCard[]>;
  abandoned(workspaceIds: string[], now: Date): Promise<Set<string>>;
  // The cards with these keys (TB-107 inputs), with their plan product.
  named(products: Map<string, string>, keys: string[]): Promise<RecentCard[]>;
  // Plan product → cards closed since then (TB-112 pace).
  closed(
    products: Map<string, string>,
    since: Date,
  ): Promise<Map<string, number>>;
}

export type PlanDeps = {
  client: QueueClient;
  config: OwnerQueueConfig;
  store: PlanStore;
  now: () => Date;
};

const RUN_DEADLINE_MS = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PlanRuns = { hourly: boolean; daily: boolean };

export type PlanOutcome = {
  written: number;
  // A version race (409): the doc waits for the next run.
  skipped: number;
  // Left for the next run by the budget.
  left: number;
  // The hourly part ran and every doc it changed is written.
  hourlyDone: boolean;
  // The daily part ran and nothing was left for lack of budget.
  dailyDone: boolean;
};

function planRows(docs: QueueDoc[]): PlanRow[] {
  return docs.filter(
    (doc) => doc.data.kind === undefined && doc.data.archived !== true,
  );
}

function refsOf(rows: PlanRow[]): CardRef[] {
  const refs: CardRef[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.data.cards)) continue;
    for (const entry of row.data.cards) {
      const ref = cardRef(entry);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

// The eta fields join the row's write of this run: one write per row.
function withEta(writes: RowWrite[], rows: PlanRow[], daily: DailyPlan) {
  const byId = new Map(writes.map((write) => [write.id, write]));
  const versions = new Map(rows.map((row) => [row.id, row.version]));
  for (const [id, patch] of daily.eta) {
    const write = byId.get(id);
    if (write) Object.assign(write.patch, patch);
    else byId.set(id, { id, version: versions.get(id) ?? 0, patch, rank: 3 });
  }
  return [...byId.values()].sort((a, b) => a.rank - b.rank);
}

// New decision: the item first (409 — it exists: the day was run already),
// then the last unanswered one archived, then the state.
async function writeDecisions(writer: PlanWriter, daily: DailyPlan) {
  for (const decision of daily.decisions) {
    const { item, state } = decision;
    const put = await writer.write(() =>
      writer.client.put("items", item.id, item.data, 0),
    );
    if (typeof put === "string") continue;
    if (decision.archive && decision.archive !== item.id) {
      await archiveItem(writer, decision.archive);
    }
    await writer.write(() =>
      writer.client.put("work", state.id, state.data, state.version),
    );
  }
}

// One run over the plan rows. Every 5 minutes: an answered due decision is
// applied (TB-112), then F4 — each row follows its cards on the board; hourly
// also F8 (the off-plan row) and F9 (the «без аренды» mark); daily the
// forecast, eta and a due decision (TB-112). A row is written once per run,
// only when a value changed, with ifVersion; 30 writes a run at most.
export async function planPass(
  deps: PlanDeps,
  runs: PlanRuns,
): Promise<PlanOutcome> {
  const writer = new PlanWriter(deps.client, Date.now() + RUN_DEADLINE_MS);
  const now = deps.now();
  const workspaceIds = [...deps.config.products.keys()];
  // The plan product, not the queue product: aiBoards&eval plans under
  // w-taibe-* (OQ_PLAN_PRODUCTS).
  const planProducts = deps.config.plan.products;
  const products = [...new Set(planProducts.values())];
  let list = await listAll(deps.client, "work");
  const answers = await applyAnswers(writer, {
    docs: list.docs,
    rows: planRows(list.docs),
    products,
    now,
  });
  const back = await applyReverts(writer, list.docs, products, now);
  if (answers.changed || back) list = await listAll(deps.client, "work");
  // A cut list may miss the row that plans a card or a row before another:
  // no off-plan decisions and no forecast then.
  if (list.truncated) {
    console.warn("owner-queue plan rows: the work list is truncated");
  }
  const withHourly = runs.hourly && !list.truncated;
  const withDaily = runs.daily && !list.truncated;
  const rows = planRows(list.docs);
  const board = await deps.store.resolve(workspaceIds, refsOf(rows));
  const { writes, missing } = planWrites({
    rows,
    board,
    today: localDate(now),
    hourly: withHourly
      ? {
          abandoned: await deps.store.abandoned(workspaceIds, now),
          recent: await deps.store.recent(planProducts, offPlanSince(now)),
          products,
          now,
        }
      : null,
  });
  if (missing.length > 0) {
    console.warn(
      `owner-queue plan rows: no row ${missing.join(", ")}; off-plan cards are not shown`,
    );
  }
  let daily: DailyPlan | null = null;
  let focus: FocusPlan[] = [];
  let ordered = writes;
  if (withDaily) {
    const patched = new Map(writes.map((write) => [write.id, write.patch]));
    const current = rows.map((row) => {
      const patch = patched.get(row.id);
      return patch ? { ...row, data: withPatch(row.data, patch) } : row;
    });
    daily = dailyPlan({
      docs: list.docs,
      rows: current,
      board,
      closed: await deps.store.closed(
        planProducts,
        new Date(now.getTime() - PACE_DAYS * DAY_MS),
      ),
      products,
      open: answers.open,
      today: localDate(now),
      now,
    });
    // TB-107 after the eta step: the owner's inputs into the plan and the
    // focus order.
    const named = await readNamed(deps.client, now);
    focus = focusPlans({
      docs: list.docs,
      rows: current,
      board,
      cards: await deps.store.named(planProducts, [...named.keys.keys()]),
      named,
      products,
      url: deps.config.url,
      today: localDate(now),
      now,
    });
    ordered = withInputs(withEta(writes, rows, daily), rows, focus);
  }
  for (const write of ordered) {
    await writer.patch("work", write.id, write.patch, write.version);
  }
  if (daily) await writeDecisions(writer, daily);
  await writeFocus(writer, focus);
  const clean = writer.skipped === 0 && writer.left === 0;
  return {
    written: writer.written,
    skipped: writer.skipped,
    left: writer.left,
    hourlyDone: withHourly && clean,
    dailyDone: withDaily && writer.left === 0,
  };
}
