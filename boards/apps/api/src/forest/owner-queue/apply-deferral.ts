import { BatchLocked } from "../approval/batch-close-apply";

// TB-114 п. 3: the owner said «Да» in the queue and the apply failed for a
// reason that is not a refusal. The item says so and counts the tries; the
// APPLY_TRIES-th failed try ends the request as failed, and the owner sees
// that nothing was applied.
export const APPLY_TRIES = 5;

// The count lives in queueSyncedStatus as «deferred:<n>» while the request is
// pending: no new column, and step 4 overwrites it with the outcome.
const DEFERRED = /^deferred:(\d+)$/;

export function deferredTries(synced: string | null): number {
  const match = synced ? DEFERRED.exec(synced) : null;
  return match ? Number(match[1]) : 0;
}

export const deferredStatus = (tries: number) => `deferred:${tries}`;

// failReason «apply_deferred:<cause>»: the agent reads the code, the owner
// the words.
const CAUSE_TEXT: Record<string, string> = {
  locked: "больше 5 карточек заняты другими записями",
  lock_timeout: "заявку держит другая запись",
  statement_timeout: "база не ответила вовремя",
  db_error: "ошибка базы",
};

function pgCode(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (typeof current === "object" && "code" in current) return current.code;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export function deferCause(error: unknown): string {
  if (error instanceof BatchLocked) return "locked";
  const code = pgCode(error);
  if (code === "55P03") return "lock_timeout";
  if (code === "57014") return "statement_timeout";
  return "db_error";
}

export const causeText = (cause: string) =>
  CAUSE_TEXT[cause] ?? CAUSE_TEXT.db_error;

export const deferredNote = (cause: string, tries: number) =>
  `Применение отложено: ${causeText(cause)}, попытка ${tries} из ${APPLY_TRIES}.`;

export const DEFERRED_FAIL = "apply_deferred";

export type DeferralWrites = {
  // Ends the request as failed with this reason (markFailed).
  fail: (reason: string) => Promise<unknown>;
  // Saves «deferred:<n>» as the request's queueSyncedStatus.
  save: (synced: string) => Promise<unknown>;
  // Writes the line to the queue item.
  note: (text: string) => Promise<unknown>;
};

// One failed apply of the owner's «Да». «failed»: the request ended, step 4
// tells the owner. «deferred»: the caller pauses the request (ApplyDeferred).
// - A failed write is logged and still answers «deferred»: without the pause
//   a batch's transaction would run again on every pass (backend lens and the
//   chain on #227). A failed markFailed repeats the last try next time.
// - The count is saved before the note: the tries stay bounded when only the
//   queue refuses the write; the note then skips a number.
export async function recordDeferral(
  request: { id: string; synced: string | null },
  error: unknown,
  writes: DeferralWrites,
  log: (...data: unknown[]) => void = console.error,
): Promise<"failed" | "deferred"> {
  const tries = deferredTries(request.synced) + 1;
  const cause = deferCause(error);
  try {
    if (tries >= APPLY_TRIES) {
      await writes.fail(`${DEFERRED_FAIL}:${cause}`);
      return "failed";
    }
    await writes.save(deferredStatus(tries));
    await writes.note(deferredNote(cause, tries));
  } catch (writeError) {
    log(
      `owner-queue: deferred try ${tries} of request ${request.id} not recorded:`,
      writeError,
    );
  }
  return "deferred";
}
