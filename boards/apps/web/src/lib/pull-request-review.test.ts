import { describe, expect, it } from "vite-plus/test";
import { HttpError } from "@/lib/http-error";
import type { ExternalLink, ExternalLinkMetadata } from "@/types/external-link";
import {
  canRequestReview,
  getPullRequestReviewState,
  getReviewErrorKey,
  getReviewHref,
  shouldRefetchAfterReviewError,
} from "./pull-request-review";

function link(
  metadata: ExternalLinkMetadata | null,
  extra: Partial<ExternalLink> = {},
): ExternalLink {
  return {
    id: "l",
    taskId: "t",
    integrationId: null,
    resourceType: "pull_request",
    externalId: "7",
    url: "https://github.com/acme/app/pull/7",
    title: null,
    metadata,
    ...extra,
  };
}

describe("pull request review state (TB-172)", () => {
  it("reads fork, running, done and idle in that order", () => {
    expect(
      getPullRequestReviewState(
        link({ fromFork: true, reviewRequested: true }),
      ),
    ).toBe("fork");
    expect(
      getPullRequestReviewState(
        link({ reviewRequested: true, reviewDoneAt: "2026-11-14T15:00:00Z" }),
      ),
    ).toBe("running");
    expect(
      getPullRequestReviewState(link({ reviewDoneAt: "2026-11-14T15:00:00Z" })),
    ).toBe("done");
    // An absent fromFork is unknown: the button stays on.
    expect(getPullRequestReviewState(link(null))).toBe("idle");
    expect(getPullRequestReviewState(link({ fromFork: false }))).toBe("idle");
  });

  it("offers a review only on an open GitHub pull request", () => {
    expect(canRequestReview(link(null))).toBe(true);
    expect(canRequestReview(link({ createdFrom: "github-import" }))).toBe(true);
    expect(canRequestReview(link({ merged: true }))).toBe(false);
    expect(canRequestReview(link({ state: "closed" }))).toBe(false);
    expect(canRequestReview(link({ state: "open" }))).toBe(true);
    expect(canRequestReview(link({ createdFrom: "gitea" }))).toBe(false);
    expect(
      canRequestReview(
        link(null, { integration: { id: "i", type: "gitlab" } }),
      ),
    ).toBe(false);
    expect(canRequestReview(link(null, { resourceType: "issue" }))).toBe(false);
  });

  it("links to the review comment, else to the pull request; never to a script URL", () => {
    expect(
      getReviewHref(
        link({ reviewUrl: "https://github.com/acme/app/pull/7#c" }),
      ),
    ).toBe("https://github.com/acme/app/pull/7#c");
    expect(getReviewHref(link({ reviewUrl: "javascript:alert(1)" }))).toBe(
      "https://github.com/acme/app/pull/7",
    );
    expect(getReviewHref(link(null))).toBe(
      "https://github.com/acme/app/pull/7",
    );
  });

  it("names the reason from the error code; refetches after 409 and 422", () => {
    const running = new HttpError(409, "x", { code: "REVIEW_RUNNING" });
    const fork = new HttpError(422, "x", { code: "PR_FROM_FORK" });
    const app = new HttpError(503, "x", { code: "GITHUB_APP_MISSING" });
    expect(getReviewErrorKey(running)).toBe(
      "settings:externalLinks.review.errorRunning",
    );
    expect(getReviewErrorKey(fork)).toBe(
      "settings:externalLinks.review.errorFork",
    );
    expect(
      getReviewErrorKey(new HttpError(422, "x", { code: "PR_CLOSED" })),
    ).toBe("settings:externalLinks.review.errorClosed");
    expect(getReviewErrorKey(app)).toBe(
      "settings:externalLinks.review.errorAppMissing",
    );
    expect(getReviewErrorKey(new TypeError("Failed to fetch"))).toBe(
      "settings:externalLinks.review.errorGeneric",
    );
    expect(shouldRefetchAfterReviewError(running)).toBe(true);
    expect(shouldRefetchAfterReviewError(fork)).toBe(true);
    expect(shouldRefetchAfterReviewError(app)).toBe(false);
  });
});
