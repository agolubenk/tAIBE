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
 * the issues), no right (`forbidden`) or anything else (`failed`).
 */
export type SaveFailure =
  | "row_version"
  | "version_mismatch"
  | "invalid"
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

async function failureOf(response: Response): Promise<SaveTaskFormError> {
  const body = await readBody(response);
  if (response.status === 409) {
    return new SaveTaskFormError(
      body.code === "version_mismatch" ? "version_mismatch" : "row_version",
    );
  }
  if (response.status === 422) {
    const issues = Array.isArray(body.issues)
      ? (body.issues as AnswerIssue[])
      : [];
    return new SaveTaskFormError("invalid", issues);
  }
  if (response.status === 403) {
    return new SaveTaskFormError("forbidden");
  }
  return new SaveTaskFormError("failed");
}

/**
 * Saves the answers as a draft, or submits them. `keepalive` lets the last
 * save outlive a closed tab; the browser caps such a body at 64 KiB.
 */
async function saveTaskFormAnswers(
  { formId, answers, submit, rowVersion }: SaveTaskFormRequest,
  { keepalive = false }: { keepalive?: boolean } = {},
): Promise<SavedTaskForm> {
  let response: Response;
  try {
    response = await fetch(
      getApiUrl(`/form/${encodeURIComponent(formId)}/answers`),
      {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers, submit, rowVersion }),
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
