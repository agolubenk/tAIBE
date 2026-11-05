import { archiveIdleAgents } from "../agent-identity/archive-idle-agents";
import { retryStorageCleanup } from "../storage/cleanup-queue";
import { cleanupDraftUploads } from "./draft-upload-cleanup";
import { replayDeferredIssueEdits } from "../plugins/github/services/deferred-issue-edits";
import * as Sentry from "@sentry/node";
import { Cron } from "croner";
import { readMirrorConfig } from "../import/notion-mirror/mirror-config";
import { runScheduledNotionMirror } from "../import/notion-mirror/run-notion-mirror";
import { checkDueDateReminders } from "./due-date-reminders";
import { syncNotebookCards } from "./notebook-card-sync";
import { checkProjectWebhookReminders } from "./project-webhook-reminders";
import { reconcileWorkspaceSeats } from "./seat-reconciliation";
import { checkTrialReminders } from "./trial-reminders";
import { runNightlySsrPush } from "./ssr-nightly-push";

const jobs: Cron[] = [];

type JobOutcome = { degraded?: boolean };

// Cron jobs swallow their operational failures (per-item try/catch) so they
// can keep processing the rest of the batch. Reporting Sentry status purely
// from the thrown-rejection channel would always show "ok" for any partially
// failed run. Inspect the returned outcome instead so handled failures light
// up the monitor without aborting the rest of the work. Unexpected throws are
// captured as exception events and swallowed so one bad tick can't take down
// the scheduler via an unhandled rejection.
function withCheckIn<T>(name: string, fn: () => Promise<T>) {
  return async (): Promise<void> => {
    const checkInId = Sentry.captureCheckIn({
      monitorSlug: name,
      status: "in_progress",
    });
    try {
      const result = await fn();
      const degraded = Boolean(
        (result as JobOutcome | null | undefined)?.degraded,
      );
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug: name,
        status: degraded ? "error" : "ok",
      });
    } catch (error) {
      Sentry.captureException(error, { tags: { area: "cron", job: name } });
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug: name,
        status: "error",
      });
      console.error(`Cron job ${name} failed`, error);
    }
  };
}

export function initializeScheduler(): void {
  jobs.push(
    new Cron(
      "* * * * *",
      withCheckIn("deferred-issue-edits", replayDeferredIssueEdits),
    ),
  );
  jobs.push(
    new Cron(
      "*/5 * * * *",
      { protect: true },
      withCheckIn("storage-cleanup", retryStorageCleanup),
    ),
  );
  jobs.push(
    new Cron(
      "31 * * * *",
      { protect: true },
      withCheckIn("draft-upload-cleanup", cleanupDraftUploads),
    ),
  );
  jobs.push(
    new Cron(
      "*/5 * * * *",
      withCheckIn("due-date-reminders", checkDueDateReminders),
    ),
  );
  jobs.push(
    new Cron(
      "*/5 * * * *",
      withCheckIn("project-webhook-reminders", checkProjectWebhookReminders),
    ),
  );
  jobs.push(
    new Cron(
      "17 * * * *",
      withCheckIn("seat-reconciliation", reconcileWorkspaceSeats),
    ),
  );
  jobs.push(
    new Cron("23 * * * *", withCheckIn("trial-reminders", checkTrialReminders)),
  );
  jobs.push(
    new Cron(
      "41 * * * *",
      { protect: true },
      withCheckIn("agent-archive", () => archiveIdleAgents()),
    ),
  );
  jobs.push(
    new Cron("10 3 * * *", withCheckIn("ssr-nightly-push", runNightlySsrPush)),
  );
  jobs.push(
    new Cron(
      "*/10 * * * *",
      { protect: true },
      withCheckIn("notebook-card-sync", syncNotebookCards),
    ),
  );
  // Off unless the mirror is configured; the job itself re-reads the config so
  // a missing token file shows up as a failed run, not a silent skip.
  const mirror = readMirrorConfig();
  if (mirror) {
    jobs.push(
      new Cron(
        mirror.cron,
        { protect: true },
        withCheckIn("notion-mirror", runScheduledNotionMirror),
      ),
    );
  }
  console.log(
    "⏰ Scheduler started (deferred integration edits every minute, reminders every 5 minutes, seat reconciliation, trial reminders and the agent archive hourly)",
  );
}

export function shutdownScheduler(): void {
  for (const job of jobs) {
    job.stop();
  }
  jobs.length = 0;
}
