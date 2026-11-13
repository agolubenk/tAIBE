import { archiveItem, applyAnswers } from "./plan-due-apply";
import { isDueChoice, readItemDue } from "./plan-due";
import { type DailyPlan, dailyPlan } from "./plan-due-daily";
import { PACE_DAYS } from "./plan-eta";
import { planWrites, type RowWrite } from "./plan-rows";
import {
  type BoardCard,
  type CardRef,
  cardRef,
  localDate,
  offPlanSince,
  type PlanRow,
  type RecentCard,
  rowProduct,
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

const DAY_MS = 24 * 60 * 60 * 1000;
// The reads (the queue list, the board queries) stop starting new work after
// READ_BUDGET_MS; the writes end WRITE_BUDGET_MS after that. The worst run ends
// within about 2.5 minutes, before the next 5-minute run.
export const READ_BUDGET_MS = 60_000;
export const WRITE_BUDGET_MS = 60_000;

export type PlanRuns = { hourly: boolean; daily: boolean };

export type PlanOutcome = {
  written: number;
  // A version race (409): the doc waits for the next run.
  skipped: number;
  // Left for the next run by the budget.
  left: number;
  // Refused by the queue (400/422): skipped, the run goes on (TB-125).
  refused: number;
  // The hourly part ran and every doc it changed is written.
  hourlyDone: boolean;
  // The daily part ran and nothing was left for lack of budget.
  dailyDone: boolean;
};

// The rows of the plan products only, by the id prefix w-<product>-, as
// eval/tools/queue_focus.py plan_rows reads them. Not the doc's queue product:
// the queue takes it from the id's own prefix (namespaceOf), so every w-… row
// is hr-helper there, w-taibe-… included.
function planRows(docs: QueueDoc[], products: string[]): PlanRow[] {
  return docs.filter(
    (doc) =>
      doc.data.kind === undefined &&
      doc.data.archived !== true &&
      rowProduct(doc.id, products) !== null,
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

// The owner answered the previous decision after applyAnswers read it (the
// same run): archiving it now would lose the answer.
async function answeredMeanwhile(writer: PlanWriter, id: string | undefined) {
  if (!id) return false;
  const check = await writer.client.get("checks", id);
  return isDueChoice(check?.data.choice);
}

type Decision = DailyPlan["decisions"][number];

// New decision: the item first, then the last unanswered one archived, then
// the state. A 409 on the item: it exists — a run wrote it and failed before
// the state. Our open decision is taken as written and the state points to
// it, with its rows as the owner reads them; any other doc there is left.
// A previous decision answered meanwhile stays: the next run applies the
// answer first, then asks anew. true — written or nothing to write; false —
// a write failed or was left, or an answer came meanwhile: the daily part
// runs again next run; "left" — the item put was left by the budget.
async function writeDecision(
  writer: PlanWriter,
  decision: Decision,
): Promise<boolean | "left"> {
  const { item, state } = decision;
  const previous =
    decision.archive && decision.archive !== item.id
      ? decision.archive
      : undefined;
  if (await answeredMeanwhile(writer, previous)) return false;
  const put = await writer.write(() =>
    writer.client.put("items", item.id, item.data, 0),
  );
  if (put === "left") return "left";
  let rows = state.data.rows;
  if (put === "skipped") {
    const existing = await writer.client.get("items", item.id);
    const due =
      existing?.data.archived === true
        ? null
        : readItemDue(existing, decision.product);
    if (!due) {
      console.warn(`owner-queue due: ${item.id} exists and is not open`);
      return true;
    }
    rows = due;
  }
  if (previous && !(await archiveItem(writer, previous))) return false;
  const written = await writer.unlessRefused(`due state ${state.id}`, () =>
    writer.write(() =>
      writer.client.put(
        "work",
        state.id,
        { ...state.data, rows },
        state.version,
      ),
    ),
  );
  if (written === "refused") {
    // No state points to the item: an answer there would never be read.
    await writer.unlessRefused(`decision ${item.id} archive`, () =>
      archiveItem(writer, item.id),
    );
    return true;
  }
  return typeof written !== "string";
}

// A refused decision is left until tomorrow's: the same refusal would come
// every run (TB-125).
async function writeDecisions(writer: PlanWriter, daily: DailyPlan) {
  let complete = true;
  for (const decision of daily.decisions) {
    const result = await writer.unlessRefused(
      `decision ${decision.item.id}`,
      () => writeDecision(writer, decision),
    );
    if (result === "left") return false;
    if (result === false) complete = false;
  }
  return complete;
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
  const readBy = Date.now() + READ_BUDGET_MS;
  const writer = new PlanWriter(deps.client, readBy + WRITE_BUDGET_MS);
  const now = deps.now();
  const workspaceIds = [...deps.config.products.keys()];
  // The plan product, not the queue product: aiBoards&eval plans under
  // w-taibe-* (OQ_PLAN_PRODUCTS).
  const planProducts = deps.config.plan.products;
  const products = [...new Set(planProducts.values())];
  let list = await listAll(deps.client, "work", readBy);
  const answers = await applyAnswers(writer, {
    docs: list.docs,
    rows: planRows(list.docs, products),
    products,
    now,
  });
  if (answers.changed) list = await listAll(deps.client, "work", readBy);
  // A cut list, or a paged walk without a snapshot, may miss the row that
  // plans a card or a row before another: no off-plan decisions and no
  // forecast then. F4 still follows the rows read.
  if (list.truncated) {
    console.warn("owner-queue plan rows: the work list is truncated");
  }
  const whole = !list.truncated && list.snapshot;
  const rows = planRows(list.docs, products);
  const board = await deps.store.resolve(workspaceIds, refsOf(rows));
  const inTime = Date.now() <= readBy;
  const withHourly = runs.hourly && whole && inTime;
  const withDaily = runs.daily && whole && inTime;
  const { writes, missing } = planWrites({
    rows,
    board,
    today: localDate(now),
    hourly: withHourly
      ? {
          abandoned: await deps.store.abandoned(workspaceIds, now),
          // The plan product, not the queue product: the off-plan row of
          // aiBoards&eval cards is w-taibe-unplanned (OQ_PLAN_PRODUCTS).
          recent: await deps.store.recent(
            deps.config.plan.products,
            offPlanSince(now),
          ),
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
  let ordered = writes;
  if (withDaily) {
    const patched = new Map(writes.map((write) => [write.id, write.patch]));
    daily = dailyPlan({
      docs: list.docs,
      rows: rows.map((row) => {
        const patch = patched.get(row.id);
        return patch ? { ...row, data: withPatch(row.data, patch) } : row;
      }),
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
    ordered = withEta(writes, rows, daily);
  }
  // A row the queue refuses is skipped; the other rows go on (TB-125).
  for (const write of ordered) {
    await writer.unlessRefused(`row ${write.id}`, () =>
      writer.patch("work", write.id, write.patch, write.version),
    );
  }
  const decided = daily ? await writeDecisions(writer, daily) : true;
  const clean = writer.skipped === 0 && writer.left === 0;
  return {
    written: writer.written,
    skipped: writer.skipped,
    left: writer.left,
    refused: writer.refused,
    hourlyDone: withHourly && clean,
    dailyDone: withDaily && writer.left === 0 && decided,
  };
}
