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
