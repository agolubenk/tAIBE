import { expiryPass } from "./expiry-pass";
import { planPass } from "./plan-pass";
import { planStore } from "./plan-store";
import { journalQueue } from "./queue-actor";
import { httpQueueClient } from "./queue-client";
import { readOwnerQueueConfig } from "./queue-config";
import { syncPass } from "./sync-pass";

// Back-off after an ops-console failure: 30 → 60 → 120 → 300 s, then 30 s
// again (spec «Синхронизация»). Kept in memory: a restart starts fresh.
const BACKOFF_SECONDS = [30, 60, 120, 300];
let backoffStep = -1;
let resumeAt = 0;
let skipJournaled = false;

async function configOrSkip() {
  const config = readOwnerQueueConfig();
  if (!config && !skipJournaled) {
    skipJournaled = true;
    await journalQueue(
      null,
      "queue.skip",
      "owner-queue",
      "sync off: OQ_URL, OQ_TOKEN_FILE, OQ_TOKEN_NAME or OQ_WORKSPACE_PRODUCTS not set; approvals work in the t-boards UI only",
    );
  }
  return config;
}

// Every 30 s (scheduler). Writes nothing to the queue when not configured.
export async function ownerQueueTick(now: number = Date.now()) {
  const config = await configOrSkip();
  if (!config || now < resumeAt) return;
  try {
    await syncPass({
      client: httpQueueClient(config),
      config,
      now: () => new Date(),
    });
    backoffStep = -1;
    resumeAt = 0;
  } catch (error) {
    backoffStep = (backoffStep + 1) % BACKOFF_SECONDS.length;
    resumeAt = now + (BACKOFF_SECONDS[backoffStep] ?? 30) * 1000;
    console.error(
      `owner-queue sync failed, next try in ${BACKOFF_SECONDS[backoffStep]} s:`,
      error,
    );
  }
}

// TB-106: the off-plan row and the «без аренды» mark once an hour. In memory:
// a restart runs them at once. A run that left a row unwritten repeats them.
const HOURLY_MS = 59 * 60 * 1000;
let hourlyAt = 0;

// Every 5 minutes (scheduler): plan rows follow the board. A failure waits for
// the next run and shows as a failed check-in, not as an exception per run.
export async function ownerQueuePlanRows(now: number = Date.now()) {
  const config = await configOrSkip();
  if (!config) return {};
  const hourly = now - hourlyAt >= HOURLY_MS;
  try {
    const outcome = await planPass(
      {
        client: httpQueueClient(config),
        config,
        store: planStore,
        now: () => new Date(),
      },
      hourly,
    );
    if (outcome.hourlyDone) hourlyAt = now;
    return {};
  } catch (error) {
    console.error("owner-queue plan rows failed:", error);
    return { degraded: true };
  }
}

// Every 5 minutes (scheduler): expiry also runs with the sync off.
export async function ownerQueueExpiry() {
  const config = await configOrSkip();
  await expiryPass(config ? { client: httpQueueClient(config), config } : null);
}
