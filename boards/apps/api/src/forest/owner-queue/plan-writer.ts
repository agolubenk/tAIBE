import {
  type QueueClient,
  QueueConflict,
  type QueueDoc,
  QueueRejected,
} from "./queue-client";

// The queue takes 120 writes a minute per token and the 30 s pass may spend
// up to 50 of them: one plan run writes 30 docs at most, the rest go next run.
export const PLAN_WRITES_PER_RUN = 30;

// «skipped» — a version race (409): the doc waits for the next run; «left» —
// the run spent its writes or its time.
export type WriteResult = QueueDoc | "skipped" | "left";

// Every write of one plan run goes through one budget.
export class PlanWriter {
  written = 0;
  skipped = 0;
  left = 0;
  refused = 0;
  private attempts = 0;

  constructor(
    readonly client: QueueClient,
    private readonly deadline: number,
  ) {}

  async write(run: () => Promise<QueueDoc>): Promise<WriteResult> {
    if (this.attempts >= PLAN_WRITES_PER_RUN || Date.now() > this.deadline) {
      this.left += 1;
      return "left";
    }
    this.attempts += 1;
    try {
      const doc = await run();
      this.written += 1;
      return doc;
    } catch (error) {
      if (!(error instanceof QueueConflict)) throw error;
      this.skipped += 1;
      return "skipped";
    }
  }

  // The queue refused a doc (400/422: schema, size). The same refusal comes
  // every run, so the run goes on without that doc (TB-125). Unlike a race or
  // the budget, a refusal does not make the run incomplete: an incomplete
  // hourly or daily part would run again every 5 minutes for nothing.
  async unlessRefused<T>(
    what: string,
    step: () => Promise<T>,
  ): Promise<T | "refused"> {
    try {
      return await step();
    } catch (error) {
      if (!(error instanceof QueueRejected)) throw error;
      this.refused += 1;
      console.warn(`owner-queue plan: ${what} refused: ${error.message}`);
      return "refused";
    }
  }

  patch(
    collection: "work" | "items" | "checks",
    id: string,
    data: Record<string, unknown>,
    ifVersion?: number,
  ) {
    return this.write(() => this.client.patch(collection, id, data, ifVersion));
  }
}
