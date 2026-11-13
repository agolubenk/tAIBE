import { expiryPass } from "./expiry-pass";
import { planCheckIn, planPass } from "./plan-pass";
import { planStore } from "./plan-store";
import { localDate, localTime } from "./plan-types";
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
// TB-112: the forecast and the due decision at the first run after 08:30
// Moscow. In memory: a restart may run the day again, every write of it is
// idempotent.
const DAILY_AFTER = "08:30";
let dailyOn = "";

// Every 5 minutes (scheduler): plan rows follow the board. A failure waits for
// the next run and shows as a failed check-in, not as an exception per run.
// A doc the queue refused (TB-125) also fails the check-in: the run goes on,
// but that row does not follow the board until someone looks. So does a 429
// in 3 runs in a row (TB-119, planCheckIn).
const planRowsCheckIn = planCheckIn();

export async function ownerQueuePlanRows(now: number = Date.now()) {
  const config = await configOrSkip();
  if (!config) return {};
  const at = new Date(now);
  const today = localDate(at);
  const runs = {
    hourly: now - hourlyAt >= HOURLY_MS,
    daily: dailyOn !== today && localTime(at) >= DAILY_AFTER,
  };
  try {
    const outcome = await planPass(
      {
        client: httpQueueClient(config),
        config,
        store: planStore,
        now: () => new Date(),
      },
      runs,
    );
    if (outcome.hourlyDone) hourlyAt = now;
    if (outcome.dailyDone) dailyOn = today;
    return planRowsCheckIn(outcome);
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
