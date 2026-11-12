import { HTTPException } from "hono/http-exception";
import {
  type ApprovalAction,
  DONE_REF_PATTERN,
  type DoneReason,
} from "./approval-params";

// TB-102 R-9 (owner d-tb102-done-1211 = doneref): a closing request names the
// commit or PR with its docs/plans/done entry, or why there is none. Checked
// before anything is stored, so the owner never gets such a request.
export function closingDoneRef(
  action: ApprovalAction,
  doneRef: string | undefined,
  doneReason: DoneReason | undefined,
): { doneRef: string | null; doneReason: DoneReason | null } {
  if (action !== "close_task") return { doneRef: null, doneReason: null };
  if (doneRef && doneReason) {
    throw new HTTPException(400, {
      message: "close_task: send doneRef or doneReason, not both",
    });
  }
  if (doneRef) {
    if (!DONE_REF_PATTERN.test(doneRef)) {
      throw new HTTPException(400, {
        message:
          "doneRef: https://github.com/agolubenk/(HR_Helper-v2|tAIBE)/(commit/<sha>|pull/<n>) with the docs/plans/done entry",
      });
    }
    return { doneRef, doneReason: null };
  }
  if (doneReason) return { doneRef: null, doneReason };
  throw new HTTPException(400, {
    message:
      "close_task needs doneRef (the commit or PR with the docs/plans/done entry) or doneReason: duplicate | obsolete | import",
  });
}
