import { describe, expect, it } from "vite-plus/test";
import { richTextMarkdown } from "./rich-text-markdown.js";

describe("richTextMarkdown", () => {
  it("leaves text without links as it is", () => {
    expect(richTextMarkdown([{ plain_text: "a [b] (c)" }])).toEqual({
      text: "a [b] (c)",
      losses: [],
    });
  });

  it("keeps a link, joining runs that share its address", () => {
    const { text, losses } = richTextMarkdown([
      { plain_text: "see " },
      { plain_text: "PR ", href: "https://github.com/x/pull/1" },
      {
        plain_text: "#1",
        href: "https://github.com/x/pull/1",
        annotations: { bold: true },
      },
    ]);
    expect(text).toBe("see [PR #1](https://github.com/x/pull/1)");
    expect(losses).toEqual([]);
  });

  it("escapes brackets in the text and parentheses in the address", () => {
    const { text } = richTextMarkdown([
      { plain_text: "a]b[c", href: "https://e.com/x_(y) z" },
    ]);
    expect(text).toBe("[a\\]b\\[c](https://e.com/x_\\(y\\)%20z)");
  });

  it("links a page mention and a relative link to Notion", () => {
    const { text } = richTextMarkdown([
      {
        plain_text: "Roadmap",
        type: "mention",
        mention: { type: "page", page: { id: "1a2b-3c4d" } },
        href: "https://www.notion.so/1a2b3c4d",
      },
      { plain_text: " · " },
      { plain_text: "spec", href: "/5e6f" },
    ]);
    expect(text).toBe(
      "[Roadmap](https://www.notion.so/1a2b3c4d) · [spec](https://www.notion.so/5e6f)",
    );
  });

  it("keeps only the text of a signed file link or another scheme", () => {
    const { text, losses } = richTextMarkdown([
      {
        plain_text: "file",
        href: "https://prod-files-secure.s3.amazonaws.com/a?X-Amz-Signature=1",
      },
      { plain_text: " and " },
      { plain_text: "run", href: "javascript:alert(1)" },
    ]);
    expect(text).toBe("file and run");
    expect(losses).toEqual(["signed", "scheme"]);
  });
});
