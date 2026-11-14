import { getApiUrl } from "@/fetchers/get-api-url";
import { HttpError } from "@/lib/http-error";
import type { ExternalLink } from "@/types/external-link";

// TB-172: sets the review label on the pull request through the GitHub App.
// Answers the link with reviewRequested; the error body carries a code
// (REVIEW_RUNNING, PR_FROM_FORK, PR_CLOSED, NOT_A_PULL_REQUEST,
// GITHUB_APP_MISSING). The path names the task, as the delete route does.
export default async function requestPullRequestReview({
  taskId,
  id,
}: {
  taskId: string;
  id: string;
}): Promise<ExternalLink> {
  const response = await fetch(
    getApiUrl(
      `/external-link/task/${encodeURIComponent(taskId)}/${encodeURIComponent(id)}/review-request`,
    ),
    { method: "POST", credentials: "include" },
  );
  if (!response.ok) throw await HttpError.fromResponse(response);
  return (await response.json()) as ExternalLink;
}
