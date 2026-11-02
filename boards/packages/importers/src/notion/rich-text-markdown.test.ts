import { describe, expect, it } from "vite-plus/test";
import type { NotionRichText } from "./api-types.js";
import { richTextMarkdown } from "./rich-text-markdown.js";

const link = (plain_text: string, href: string): NotionRichText => ({
  plain_text,
  href,
});

describe("richTextMarkdown", () => {
  it("leaves plain text as it is, apart from markup characters", () => {
    expect(richTextMarkdown([{ plain_text: "a (c) — b" }])).toEqual({
      text: "a (c) — b",
      losses: [],
    });
  });

  it("keeps a link, joining runs that share its address", () => {
    const { text, losses } = richTextMarkdown([
      { plain_text: "see " },
      link("PR ", "https://github.com/x/pull/1"),
      {
        plain_text: "#1",
        href: "https://github.com/x/pull/1",
        annotations: { bold: true },
      },
    ]);
    expect(text).toBe("see [PR #1](https://github.com/x/pull/1)");
    expect(losses).toEqual([]);
  });

  it("escapes markup in the text and percent-encodes the address", () => {
    const { text } = richTextMarkdown([
      link("a]b[c", "https://e.com/x_(y) z<w>"),
    ]);
    expect(text).toBe("[a\\]b\\[c](https://e.com/x_%28y%29%20z%3Cw%3E)");
  });

  it("writes the address in the parser's form", () => {
    const { text } = richTextMarkdown([
      link("q", "HTTPS://Example.COM/a b?x=\\(1)#f g"),
    ]);
    expect(text).toBe("[q](https://example.com/a%20b?x=%5C%281%29#f%20g)");
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
      link("spec", "/5e6f"),
    ]);
    expect(text).toBe(
      "[Roadmap](https://www.notion.so/1a2b3c4d) · [spec](https://www.notion.so/5e6f)",
    );
  });

  // Lens 4, 30.10: each case gives the text and the line of losses.
  it.each([
    ["javascript:alert(1)", "scheme"],
    ["JAVASCRIPT:alert(1)", "scheme"],
    ["\tjavascript:alert(1)", "scheme"],
    ["\tjava script:alert(1)", "scheme"],
    ["//evil.example/x", "scheme"],
    ["evil.example/x", "scheme"],
    ["data:text/html,x", "scheme"],
    ["mailto:ann@example.com", "personal"],
    ["https://user:pass@example.com/", "signed"],
    [
      "https://prod-files-secure.s3.amazonaws.com/a?X-Amz-Signature=1",
      "signed",
    ],
    ["https://storage.example/a?X-Goog-Signature=1", "signed"],
    ["https://e.example/a?Expires=1&x=2", "signed"],
    ["https://e.example/a?access_token=1", "signed"],
    ["https://e.example/cb#access_token=1", "signed"],
    ["https://e.example/a?SIG=1", "signed"],
    ["https://e.example/#/cb?access_token=1", "signed"],
    ["https://e.example/a?access%5Ftoken=1", "signed"],
    ["https://e.example/a#!sig=1", "signed"],
    ["https://e.example/a?access%5Ftoken=1&x=%ZZ", "signed"],
    ["https://e.example/a?q=%E0%A4%A&%73ig=1", "signed"],
  ])("keeps only the text of %j", (href, loss) => {
    expect(richTextMarkdown([link("a", href)])).toEqual({
      text: "a",
      losses: [loss],
    });
  });

  it("keeps an address whose keys only contain a signed word", () => {
    expect(
      richTextMarkdown([link("d", "https://e.example/a?design=1&tokens=2")]),
    ).toEqual({
      text: "[d](https://e.example/a?design=1&tokens=2)",
      losses: [],
    });
  });

  it("keeps an address that ends in a parenthesis inside the link", () => {
    expect(richTextMarkdown([link("x", "https://a)b")])).toEqual({
      text: "[x](https://a%29b/)",
      losses: [],
    });
  });

  it.each([
    ["](https://evil)", "\\](https://evil)"],
    ["[a](javascript:x)", "\\[a\\](javascript:x)"],
    ["<img src=x onerror=alert(1)>", "\\<img src=x onerror=alert(1)\\>"],
    ["&lt; a & b \\", "\\&lt; a \\& b \\\\"],
  ])("escapes %j in plain text so it opens no link or tag", (input, out) => {
    expect(richTextMarkdown([{ plain_text: input }])).toEqual({
      text: out,
      losses: [],
    });
  });

  it("names each kind of loss once", () => {
    const { text, losses } = richTextMarkdown([
      link("file", "https://e.example/a?token=1"),
      { plain_text: " and " },
      link("run", "javascript:alert(1)"),
      { plain_text: " or " },
      link("mail", "mailto:x@example.com"),
      { plain_text: " · " },
      link("code", "https://e.example/b?signature=2"),
    ]);
    expect(text).toBe("file and run or mail · code");
    expect(losses).toEqual(["signed", "scheme", "personal"]);
  });
});
