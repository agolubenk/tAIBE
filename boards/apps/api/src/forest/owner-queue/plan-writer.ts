import {
  type QueueClient,
  QueueConflict,
  type QueueDoc,
  QueueRejected,
  QueueThrottled,
} from "./queue-client";
import { PLAN_WRITES_PER_RUN } from "./queue-limits";

export { PLAN_WRITES_PER_RUN } from "./queue-limits";

// «skipped» — a version race (409): the doc waits for the next run; «left» —
// the run spent its writes or its time, or the queue answered 429.
export type WriteResult = QueueDoc | "skipped" | "left";

// Every write of one plan run goes through one budget.
export class PlanWriter {
  written = 0;
  skipped = 0;
  left = 0;
  refused = 0;
  private attempts = 0;
  // The queue answered 429 in this run (TB-119).
  throttled = false;

  constructor(
    readonly client: QueueClient,
    private readonly deadline: number,
  ) {}

  async write(run: () => Promise<QueueDoc>): Promise<WriteResult> {
    if (
      this.throttled ||
      this.attempts >= PLAN_WRITES_PER_RUN ||
      Date.now() > this.deadline
    ) {
      this.left += 1;
      return "left";
    }
    this.attempts += 1;
    try {
      const doc = await run();
      this.written += 1;
      return doc;
    } catch (error) {
      if (error instanceof QueueThrottled) {
        // The window frees up in seconds, not within this run: no retry here,
        // the doc and the rest of the run wait for the next run (TB-119).
        console.warn(`owner-queue plan: ${error.message}; the rest waits`);
        this.throttled = true;
        this.left += 1;
        return "left";
      }
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
