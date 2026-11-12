import { expiryPass } from "./expiry-pass";
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

// Every 5 minutes (scheduler): expiry also runs with the sync off.
export async function ownerQueueExpiry() {
  const config = await configOrSkip();
  await expiryPass(config ? { client: httpQueueClient(config), config } : null);
}
