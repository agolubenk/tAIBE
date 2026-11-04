export type AddedSourceKind = "github-pr" | "link";

// Mirrors the API's PR parser: a PR page (any tab) or its ref owner/repo#n
// goes to the GitHub route, anything else is fetched as a page.
const PR_URL =
  /^https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d+(?:[/?#].*)?$/;
const PR_REF = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#\d+$/;

export function addedSourceKind(input: string): AddedSourceKind {
  const value = input.trim();
  return PR_URL.test(value) || PR_REF.test(value) ? "github-pr" : "link";
}

export function isRefreshable(kind: string): kind is AddedSourceKind {
  return kind === "github-pr" || kind === "link";
}
