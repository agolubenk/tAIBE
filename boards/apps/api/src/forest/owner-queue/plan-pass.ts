import { listAll, type QueueClient, QueueConflict } from "./queue-client";
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
const RUN_DEADLINE_MS = 120_000;

export type PlanOutcome = {
  written: number;
  // A version race (409): the row waits for the next run.
  skipped: number;
  // Left for the next run by the budget.
  left: number;
  // The hourly part ran and every row it changed is written.
  hourlyDone: boolean;
};

function planRows(docs: PlanRow[]): PlanRow[] {
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

// One run over the plan rows (TB-106): every 5 minutes F4 — each row follows
// its cards on the board; with hourly also F8 (the off-plan row) and F9 (the
// «без аренды» mark). A row is written once per run, only when a value
// changed, with ifVersion.
export async function planPass(
  deps: PlanDeps,
  hourly: boolean,
): Promise<PlanOutcome> {
  const deadline = Date.now() + RUN_DEADLINE_MS;
  const now = deps.now();
  const workspaceIds = [...deps.config.products.keys()];
  const list = await listAll(deps.client, "work");
  // A cut list may miss the row that plans a card: no off-plan decisions then.
  if (list.truncated) {
    console.warn("owner-queue plan rows: the work list is truncated");
  }
  const withHourly = hourly && !list.truncated;
  const rows = planRows(list.docs);
  const board = await deps.store.resolve(workspaceIds, refsOf(rows));
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
          products: [...new Set(deps.config.plan.products.values())],
          now,
        }
      : null,
  });
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
