import { getExternalWebUrl } from "@/lib/external-url";
import { HttpError } from "@/lib/http-error";
import type { ExternalLink } from "@/types/external-link";

// TB-172: the review of a pull request on a button. The state lives in the
// link's metadata, so it is the same after a reload.
export type PullRequestReviewState = "idle" | "running" | "done" | "fork";

// Only an open GitHub pull request can be reviewed: the server sets the
// label through the GitHub App. Gitea and GitLab links have no App.
export function canRequestReview(link: ExternalLink): boolean {
  if (link.resourceType !== "pull_request") return false;
  if (link.metadata?.merged === true) return false;
  // Closed without a merge; a reopen resets the state.
  if (link.metadata?.state === "closed") return false;
  const type = link.integration?.type;
  if (type) return type === "github";
  const from = link.metadata?.createdFrom;
  return !from || from === "github" || from === "github-import";
}

export function getPullRequestReviewState(
  link: ExternalLink,
): PullRequestReviewState {
  const metadata = link.metadata;
  // An absent fromFork is unknown: the button stays on, the server says 422.
  if (metadata?.fromFork === true) return "fork";
  if (metadata?.reviewRequested === true) return "running";
  if (metadata?.reviewDoneAt) return "done";
  return "idle";
}

// The review comment, else the pull request itself.
export function getReviewHref(link: ExternalLink): string | null {
  const reviewUrl = link.metadata?.reviewUrl;
  return (
    (reviewUrl ? getExternalWebUrl(reviewUrl) : null) ??
    getExternalWebUrl(link.url)
  );
}

const ERROR_KEYS: Record<string, string> = {
  REVIEW_RUNNING: "settings:externalLinks.review.errorRunning",
  PR_FROM_FORK: "settings:externalLinks.review.errorFork",
  PR_CLOSED: "settings:externalLinks.review.errorClosed",
  NOT_A_PULL_REQUEST: "settings:externalLinks.review.errorNotPullRequest",
  GITHUB_APP_MISSING: "settings:externalLinks.review.errorAppMissing",
};

export function getReviewErrorKey(error: unknown): string {
  const code = error instanceof HttpError ? error.code : undefined;
  return (
    (code && ERROR_KEYS[code]) ?? "settings:externalLinks.review.errorGeneric"
  );
}

// 409 and 422 are decided on the live pull request; the server may have
// fixed the stored state, so the list is read again.
export function shouldRefetchAfterReviewError(error: unknown): boolean {
  return (
    error instanceof HttpError && (error.status === 409 || error.status === 422)
  );
}
