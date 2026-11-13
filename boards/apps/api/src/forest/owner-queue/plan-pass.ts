import {
  listAll,
  type QueueClient,
  QueueConflict,
  type QueueDoc,
} from "./queue-client";
import type { OwnerQueueConfig } from "./queue-config";
import { planWrites } from "./plan-rows";
import {
  type BoardCard,
  type CardRef,
  cardRef,
  localDate,
  offPlanSince,
  type PlanRow,
  type RecentCard,
  rowProduct,
} from "./plan-types";

// The board side of a run (plan-store.ts); tests use an in-memory one. Every
// read stays inside the workspaces mapped to a product.
export interface PlanStore {
  resolve(
    workspaceIds: string[],
    refs: CardRef[],
  ): Promise<Map<string, BoardCard>>;
  recent(products: Map<string, string>, since: Date): Promise<RecentCard[]>;
  abandoned(workspaceIds: string[], now: Date): Promise<Set<string>>;
}

export type PlanDeps = {
  client: QueueClient;
  config: OwnerQueueConfig;
  store: PlanStore;
  now: () => Date;
};

// The queue takes 120 writes a minute per token and the 30 s pass may spend
// up to 50 of them: one run writes 30 rows at most, the rest go next run.
export const PLAN_WRITES_PER_RUN = 30;
// The reads (the queue list, the board queries) stop starting new work after
// READ_BUDGET_MS; the writes get WRITE_BUDGET_MS from the end of the reads.
// The worst run ends within about 2.5 minutes, before the next 5-minute run.
export const READ_BUDGET_MS = 60_000;
export const WRITE_BUDGET_MS = 60_000;

export type PlanOutcome = {
  written: number;
  // A version race (409): the row waits for the next run.
  skipped: number;
  // Left for the next run by the budget.
  left: number;
  // The hourly part ran and every row it changed is written.
  hourlyDone: boolean;
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

// One run over the plan rows (TB-106): every 5 minutes F4 — each row follows
// its cards on the board; with hourly also F8 (the off-plan row) and F9 (the
// «без аренды» mark). A row is written once per run, only when a value
// changed, with ifVersion.
export async function planPass(
  deps: PlanDeps,
  hourly: boolean,
): Promise<PlanOutcome> {
  const readBy = Date.now() + READ_BUDGET_MS;
  const now = deps.now();
  const workspaceIds = [...deps.config.products.keys()];
  const products = [...new Set(deps.config.plan.products.values())];
  const list = await listAll(deps.client, "work", readBy);
  // A cut list, or a paged walk without a snapshot, may miss the row that
  // plans a card: no off-plan decisions then. F4 still follows the rows read.
  if (list.truncated) {
    console.warn("owner-queue plan rows: the work list is truncated");
  }
  const rows = planRows(list.docs, products);
  const board = await deps.store.resolve(workspaceIds, refsOf(rows));
  const withHourly =
    hourly && !list.truncated && list.snapshot && Date.now() <= readBy;
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
  const deadline = Date.now() + WRITE_BUDGET_MS;
  if (missing.length > 0) {
    console.warn(
      `owner-queue plan rows: no row ${missing.join(", ")}; off-plan cards are not shown`,
    );
  }
  const outcome = { written: 0, skipped: 0, left: 0, hourlyDone: false };
  for (const [index, write] of writes.entries()) {
    if (index >= PLAN_WRITES_PER_RUN || Date.now() > deadline) {
      outcome.left = writes.length - index;
      break;
    }
    try {
      await deps.client.patch("work", write.id, write.patch, write.version);
      outcome.written += 1;
    } catch (error) {
      if (!(error instanceof QueueConflict)) throw error;
      outcome.skipped += 1;
    }
  }
  outcome.hourlyDone =
    withHourly && outcome.skipped === 0 && outcome.left === 0;
  return outcome;
}
