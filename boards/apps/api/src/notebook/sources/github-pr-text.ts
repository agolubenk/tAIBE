// GitHub caps a body at 65 536 characters. With these caps a PR is at most
// ~460 000 characters, under SOURCE_TEXT_MAX.
export const PR_BODY_MAX = 50_000;
export const PR_COMMENTS_MAX = 100;
export const PR_COMMENT_MAX = 4_000;
export const PR_TITLE_MAX = 300;

export type PullRequestData = {
  title: string;
  body?: string | null;
  state: string;
  merged?: boolean | null;
  draft?: boolean | null;
  html_url: string;
  user?: { login: string } | null;
  base: { ref: string };
  head: { ref: string };
  comments?: number;
};

export type PullRequestComment = {
  body?: string | null;
  created_at: string;
  user?: { login: string } | null;
};

function capped(text: string | null | undefined, max: number) {
  const trimmed = (text ?? "").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n\n[…]` : trimmed;
}

const author = (user?: { login: string } | null) =>
  user ? `@${user.login}` : "ghost";

export function pullRequestTitle(ref: string, pr: PullRequestData) {
  return `${ref} ${pr.title}`.slice(0, PR_TITLE_MAX);
}

// The PR is one source: ref and title as the top heading, the fields a reader
// filters by on one line, the description, then the conversation in order.
export function pullRequestText(
  ref: string,
  pr: PullRequestData,
  comments: PullRequestComment[],
) {
  const state = pr.merged ? "merged" : pr.draft ? "draft" : pr.state;
  const fields = [
    `state: ${state}`,
    `author: ${author(pr.user)}`,
    `branch: ${pr.head.ref} → ${pr.base.ref}`,
  ];
  const blocks = [
    `# ${pullRequestTitle(ref, pr)}`,
    fields.join(" · "),
    pr.html_url,
  ];
  const body = capped(pr.body, PR_BODY_MAX);
  if (body) blocks.push(body);
  const shown = comments.slice(0, PR_COMMENTS_MAX);
  if (shown.length) {
    blocks.push("## Discussion");
    for (const comment of shown) {
      const date = comment.created_at.slice(0, 10);
      blocks.push(
        `### ${author(comment.user)} · ${date}`,
        capped(comment.body, PR_COMMENT_MAX),
      );
    }
    const total = Math.max(pr.comments ?? 0, comments.length);
    if (total > shown.length) {
      blocks.push(`${total - shown.length} later comments are not included.`);
    }
  }
  return blocks.filter(Boolean).join("\n\n");
}
