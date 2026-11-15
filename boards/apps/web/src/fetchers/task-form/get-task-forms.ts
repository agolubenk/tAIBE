// Type imports only: the task card loads this fetcher on every open, and the
// forms package itself stays in the lazy chunk of the forms section (TB-173).
import type { AnswersDoc, FormTemplate } from "@kaneo/forms";
import { getApiUrl } from "@/fetchers/get-api-url";
import { HttpError } from "@/lib/http-error";

export type TaskFormStatus = "draft" | "submitted";

export type TaskForm = {
  id: string;
  template: FormTemplate;
  answers: AnswersDoc | null;
  status: TaskFormStatus;
  rowVersion: number;
  submittedAt: string | null;
};

async function getTaskForms(taskId: string): Promise<TaskForm[]> {
  const response = await fetch(
    getApiUrl(`/form/task/${encodeURIComponent(taskId)}`),
    { credentials: "include" },
  );
  // No route yet (the web deployed before the API) or no task: no forms.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw await HttpError.fromResponse(response);
  }
  const body = (await response.json()) as { forms: TaskForm[] };
  return body.forms;
}

export default getTaskForms;
