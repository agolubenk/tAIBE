import { describe, expect, it } from "vite-plus/test";
import { chunkMarkdown } from "./chunk-markdown";

describe("chunkMarkdown", () => {
  it("keeps the heading path on every chunk", () => {
    const chunks = chunkMarkdown(
      "Intro line\n\n# Spec\n\nTop.\n\n## Data\n\nRows.\n\n### Tables\n\nColumns.\n\n## API\n\nRoutes.",
    );
    expect(chunks).toEqual([
      { heading: "", text: "Intro line" },
      { heading: "Spec", text: "Top." },
      { heading: "Spec › Data", text: "Rows." },
      { heading: "Spec › Data › Tables", text: "Columns." },
      { heading: "Spec › API", text: "Routes." },
    ]);
  });

  it("does not read a heading inside a code fence", () => {
    const chunks = chunkMarkdown(
      "# Run\n\n```sh\n# not a heading\n\necho ok\n```\n\nAfter.",
    );
    expect(chunks).toEqual([
      {
        heading: "Run",
        text: "```sh\n# not a heading\n\necho ok\n```\n\nAfter.",
      },
    ]);
  });

  it("packs paragraphs up to the limit and splits an oversized one", () => {
    const paragraph = "a".repeat(40);
    const chunks = chunkMarkdown(
      `# S\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${"b".repeat(130)}`,
      100,
    );
    expect(chunks.map(({ text }) => text.length)).toEqual([82, 40, 100, 30]);
    expect(chunks.every(({ heading }) => heading === "S")).toBe(true);
    expect(chunks.every(({ text }) => text.length <= 100)).toBe(true);
  });

  it("drops empty sections and normalises line endings", () => {
    expect(chunkMarkdown("# Empty\r\n\r\n# Full\r\nText\r\n")).toEqual([
      { heading: "Full", text: "Text" },
    ]);
    expect(chunkMarkdown("")).toEqual([]);
  });

  it("cuts a closing run of #s only after a space", () => {
    expect(
      chunkMarkdown("## Data ##\n\nRows.\n\n## C#\n\nCode.").map(
        (chunk) => chunk.heading,
      ),
    ).toEqual(["Data", "C#"]);
  });

  // The lazy heading regex took minutes on such a line (quadratic).
  // Both regex forms backtracked quadratically: minutes on 400 000 characters.
  it.each([
    ["#s", `# x${"#".repeat(400_000)}y`],
    ["spaces before U+2028", `# ${" ".repeat(400_000)}\u2028x`],
  ])("reads a long heading line of %s in linear time", (_case, line) => {
    const started = performance.now();
    chunkMarkdown(`${line}\n\nText`);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("caps a heading and its path so chunks do not copy huge titles", () => {
    const chunks = chunkMarkdown(
      `# ${"a".repeat(5000)}\n\n${"## b\n\nc\n\n".repeat(3)}`,
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.heading).toBe(`${"a".repeat(200)} › b`);
    const deep = chunkMarkdown(
      `${["#", "##", "###", "####"].map((h) => `${h} ${"d".repeat(200)}`).join("\n")}\n\nx`,
    );
    expect(deep[0]?.heading.length).toBe(500);
  });
});
