import { describe, expect, it } from "vite-plus/test";
import {
  PR_BODY_MAX,
  PR_COMMENT_MAX,
  PR_COMMENTS_MAX,
  type PullRequestData,
  pullRequestText,
} from "./github-pr-text";

const pr: PullRequestData = {
  title: "Аренда карточек",
  body: "## Зачем\n\nАренда истекает через час.",
  state: "closed",
  merged: true,
  html_url: "https://github.com/example/repo/pull/7",
  user: { login: "ann" },
  base: { ref: "main" },
  head: { ref: "feat/lease" },
  comments: 1,
};

describe("pullRequestText", () => {
  it("puts the fields, the description and the discussion in order", () => {
    expect(
      pullRequestText("example/repo#7", pr, [
        {
          body: "Fencing проверен.",
          created_at: "2026-10-30T06:52:00Z",
          user: null,
        },
      ]),
    ).toBe(
      [
        "# example/repo#7 Аренда карточек",
        "state: merged · author: @ann · branch: feat/lease → main",
        "https://github.com/example/repo/pull/7",
        "## Зачем\n\nАренда истекает через час.",
        "## Discussion",
        "### ghost · 2026-10-30",
        "Fencing проверен.",
      ].join("\n\n"),
    );
  });

  it("caps the description, each comment and the number of comments", () => {
    const comment = {
      body: "c".repeat(PR_COMMENT_MAX + 50),
      created_at: "2026-10-30T00:00:00Z",
      user: { login: "bot" },
    };
    const text = pullRequestText(
      "example/repo#7",
      {
        ...pr,
        merged: false,
        draft: true,
        body: "b".repeat(PR_BODY_MAX + 50),
        comments: 250,
      },
      Array.from({ length: PR_COMMENTS_MAX + 5 }, () => comment),
    );

    expect(text).toContain("state: draft");
    expect(text).toContain(`${"b".repeat(PR_BODY_MAX)}\n\n[…]`);
    expect(text).not.toContain("b".repeat(PR_BODY_MAX + 1));
    expect(text).not.toContain("c".repeat(PR_COMMENT_MAX + 1));
    expect(text.match(/^### @bot/gm)).toHaveLength(PR_COMMENTS_MAX);
    expect(text).toContain("150 later comments are not included.");
    expect(text.length).toBeLessThan(500_000);
  });
});
