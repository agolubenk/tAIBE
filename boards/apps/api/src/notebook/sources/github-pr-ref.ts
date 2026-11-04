import { ApiError } from "../../errors/api-error";

export type PullRequestRef = {
  owner: string;
  repo: string;
  number: number;
  // owner/repo#n, lower case: GitHub names ignore case, the notebook ref not.
  ref: string;
};

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9._-]{1,100}";
const PR_URL = new RegExp(
  `^https://(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/pull/(\\d{1,9})(?:[/?#].*)?$`,
);
const PR_REF = new RegExp(`^(${OWNER})/(${REPO})#(\\d{1,9})$`);

// A PR page URL (any tab of it) or the ref the notebook shows, owner/repo#n.
export function parsePullRequestRef(input: string): PullRequestRef {
  const match = PR_URL.exec(input.trim()) ?? PR_REF.exec(input.trim());
  const [, owner, repo, digits] = match ?? [];
  const number = Number(digits);
  if (!owner || !repo || !Number.isSafeInteger(number) || number < 1) {
    throw new ApiError(400, {
      code: "PR_INVALID_URL",
      message:
        "Enter a GitHub pull request URL, such as https://github.com/owner/repo/pull/12.",
    });
  }
  return {
    owner,
    repo,
    number,
    ref: `${owner}/${repo}#${number}`.toLowerCase(),
  };
}
