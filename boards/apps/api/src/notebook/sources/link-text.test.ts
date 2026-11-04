import { describe, expect, it } from "vite-plus/test";
import { chunkMarkdown } from "../chunk/chunk-markdown";
import { LINK_TITLE_MAX, linkSourceText } from "./link-text";

const URL_ = new URL("https://docs.example.com/forest/lease");

describe("linkSourceText", () => {
  it("turns an HTML page into text whose headings become chunks", () => {
    const page = linkSourceText(URL_, {
      mime: "text/html",
      body: "<title>Аренда</title><h2>Срок</h2><p>Истекает через час.</p>",
    });

    expect(page.title).toBe("Аренда");
    expect(page.text).toBe(
      "# Аренда\n\nhttps://docs.example.com/forest/lease\n\n## Срок\n\nИстекает через час.",
    );
    expect(chunkMarkdown(page.text).map((chunk) => chunk.heading)).toEqual([
      "Аренда",
      "Аренда › Срок",
    ]);
  });

  it("titles Markdown by its first heading and plain text by its address", () => {
    expect(
      linkSourceText(URL_, {
        mime: "text/markdown",
        body: "Intro\r\n\r\n## Lease ##\r\nText",
      }),
    ).toMatchObject({ title: "Lease", body: "Intro\n\n## Lease ##\nText" });
    expect(
      linkSourceText(URL_, { mime: "text/plain", body: "  just text  " }),
    ).toMatchObject({
      title: "docs.example.com/forest/lease",
      body: "just text",
    });
    expect(
      linkSourceText(new URL("https://docs.example.com/"), {
        mime: "text/plain",
        body: "x",
      }).title,
    ).toBe("docs.example.com");
  });

  it("keeps a long title within the source title limit", () => {
    const page = linkSourceText(URL_, {
      mime: "text/html",
      body: `<title>${"Лес ".repeat(200)}</title><p>x</p>`,
    });
    expect(page.title.length).toBe(LINK_TITLE_MAX);
  });
});
