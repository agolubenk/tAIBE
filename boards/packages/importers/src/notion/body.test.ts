import { describe, expect, it } from "vite-plus/test";
import type { NotionBlock } from "./api-types.js";
import { blocksToMarkdown, bodyGaps } from "./body.js";

const text = (plain_text: string) => [{ plain_text }];
const block = (
  type: string,
  payload: Record<string, unknown> = {},
  children?: NotionBlock[],
): NotionBlock => ({
  id: `${type}-${Math.random()}`,
  type,
  [type]: payload,
  ...(children ? { has_children: true, children } : {}),
});

describe("blocksToMarkdown", () => {
  it("renders a table with its first row as the header", () => {
    const table = block("table", {}, [
      block("table_row", { cells: [text("a"), text("b")] }),
      block("table_row", { cells: [text("1"), text("2")] }),
    ]);
    expect(blocksToMarkdown([table])).toBe(
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
    );
  });

  it("keeps a toggle heading's children", () => {
    const heading = block("heading_2", { rich_text: text("Plan") }, [
      block("paragraph", { rich_text: text("inside") }),
    ]);
    expect(blocksToMarkdown([heading])).toBe("## Plan\n\ninside");
  });

  it("names a Notion-hosted file instead of its expiring link, with the caption", () => {
    const image = block("image", {
      file: { url: "https://s3.example/signed?X-Amz=1" },
      caption: text("Схема"),
    });
    const markdown = blocksToMarkdown([image]);
    expect(markdown).toBe("[файл Notion не перенесён: image]\n\nСхема");
    expect(markdown).not.toContain("s3.example");
  });

  it("links external files and embeds", () => {
    const pdf = block("pdf", {
      external: { url: "https://example.com/a.pdf" },
    });
    const embed = block("embed", { url: "https://example.com/board" });
    expect(blocksToMarkdown([pdf, embed])).toBe(
      "[https://example.com/a.pdf](https://example.com/a.pdf)\n\n[https://example.com/board](https://example.com/board)",
    );
  });

  it("keeps an equation as a math block", () => {
    expect(
      blocksToMarkdown([block("equation", { expression: "x_1 + y" })]),
    ).toBe("```math\nx_1 + y\n```");
  });
});

describe("bodyGaps", () => {
  it("counts blocks the body leaves out and files it does not carry", () => {
    const blocks = [
      block("child_database", { title: "Inner" }),
      block("column_list", {}, [
        block("column", {}, [
          block("file", { file: { url: "https://s3.example/f" } }),
          block("video", { external: { url: "https://youtu.be/x" } }),
          block("table_of_contents"),
        ]),
      ]),
    ];
    expect(bodyGaps(blocks)).toEqual({
      unrendered: { child_database: 1, table_of_contents: 1 },
      files: { file: 1 },
    });
  });
});
