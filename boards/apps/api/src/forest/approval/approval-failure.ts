import { HTTPException } from "hono/http-exception";

// A refusal of the target itself (card gone, path closed, label deleted): the
// request ends as «failed» with this reason and nothing changes (TB-102).
export class ApprovalFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ApprovalFailure";
  }
}

// Domain refusals end the request as «failed»; anything else (database down,
// a bug) leaves it «pending» so the next pass tries again.
export function failureReason(error: unknown): string | null {
  if (error instanceof ApprovalFailure) return error.reason;
  // 408 and 429 are transient: the request stays pending for the next pass.
  if (
    error instanceof HTTPException &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  ) {
    return error.message.slice(0, 500) || `http_${error.status}`;
  }
  return null;
}
