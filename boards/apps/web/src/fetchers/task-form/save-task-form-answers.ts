import type { AnswerIssue, AnswersDoc } from "@kaneo/forms";
import { getApiUrl } from "@/fetchers/get-api-url";
import type { TaskFormStatus } from "./get-task-forms";

export type SaveTaskFormRequest = {
  formId: string;
  answers: AnswersDoc;
  submit: boolean;
  rowVersion: number;
};

export type SavedTaskForm = {
  status: TaskFormStatus;
  rowVersion: number;
  submittedAt: string | null;
};

/**
 * Why a save failed: another save came first (`row_version`), the template
 * changed (`version_mismatch`), the answers were refused (`invalid`, with
 * the issues), the body is over the limit (`too_large`, 413), no right
 * (`forbidden`) or anything else (`failed`).
 */
export type SaveFailure =
  | "row_version"
  | "version_mismatch"
  | "invalid"
  | "too_large"
  | "forbidden"
  | "failed";

export class SaveTaskFormError extends Error {
  constructor(
    readonly failure: SaveFailure,
    readonly issues: AnswerIssue[] = [],
  ) {
    super(failure);
    this.name = "SaveTaskFormError";
  }
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// The API error codes (apiErrorSchema, UPPER_SNAKE): 409 ROW_VERSION_CONFLICT
// or VERSION_MISMATCH, 422 INVALID_ANSWERS with `answerIssues`, 413
// PAYLOAD_TOO_LARGE (TB-173, #358).
async function failureOf(response: Response): Promise<SaveTaskFormError> {
  const body = await readBody(response);
  if (response.status === 409) {
    return new SaveTaskFormError(
      body.code === "VERSION_MISMATCH" ? "version_mismatch" : "row_version",
    );
  }
  if (response.status === 422) {
    const issues = Array.isArray(body.answerIssues)
      ? (body.answerIssues as AnswerIssue[])
      : [];
    return new SaveTaskFormError("invalid", issues);
  }
  if (response.status === 413) {
    return new SaveTaskFormError("too_large");
  }
  if (response.status === 403) {
    return new SaveTaskFormError("forbidden");
  }
  return new SaveTaskFormError("failed");
}

/** The PUT body as sent: its byte length is what the API limit counts. */
export function saveBodyOf({
  answers,
  submit,
  rowVersion,
}: SaveTaskFormRequest): string {
  return JSON.stringify({ answers, submit, rowVersion });
}

/**
 * Saves the answers as a draft, or submits them. `keepalive` lets the last
 * save outlive a closed tab; the browser caps such a body at 64 KiB.
 */
async function saveTaskFormAnswers(
  request: SaveTaskFormRequest,
  { keepalive = false }: { keepalive?: boolean } = {},
): Promise<SavedTaskForm> {
  let response: Response;
  try {
    response = await fetch(
      getApiUrl(`/form/${encodeURIComponent(request.formId)}/answers`),
      {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: saveBodyOf(request),
        keepalive,
      },
    );
  } catch {
    throw new SaveTaskFormError("failed");
  }
  if (!response.ok) {
    throw await failureOf(response);
  }
  return (await response.json()) as SavedTaskForm;
}

export default saveTaskFormAnswers;
