import { describe, expect, it } from "vite-plus/test";
import { excerptAround, excerptSearchResults } from "./excerpt.js";

const long = `${"a ".repeat(150)}The Needle sits here${" b".repeat(150)}`;

describe("excerptAround", () => {
  it("keeps short text whole, with whitespace collapsed", () => {
    expect(excerptAround("one\n\n  two", "two")).toBe("one two");
  });

  it("cuts a window around the match, case-insensitive", () => {
    const excerpt = excerptAround(long, "needle", 20);
    expect(excerpt).toContain("The Needle sits here");
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(20 * 2 + "needle".length + 2);
  });

  it("cuts the window at the first word when the words are apart (TB-162)", () => {
    const excerpt = excerptAround(long, "here needle", 20);
    expect(excerpt).toContain("The Needle sits here");
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerptAround(long, "absent here", 20)).toContain("sits here");
    const apart = `${"a ".repeat(150)}Needle${" b".repeat(150)} later${" c".repeat(50)}`;
    const first = excerptAround(apart, "later needle", 20);
    expect(first).toContain("Needle");
    expect(first).not.toContain("later");
  });

  it("falls back to the start when the match is not in this text", () => {
    expect(excerptAround(long, "absent", 10)).toBe(`${"a ".repeat(10)}…`);
  });
});

describe("excerptSearchResults", () => {
  it("shortens descriptions and comments, leaves the rest", () => {
    const data = {
      results: [
        { id: "t1", title: "Task", description: long },
        { id: "c1", title: "Comment", content: long, userName: "Ann" },
      ],
      totalCount: 2,
      searchQuery: "needle",
    };

    const out = excerptSearchResults(data, "needle") as typeof data;

    expect(out.totalCount).toBe(2);
    expect(out.results[0]?.title).toBe("Task");
    expect(out.results[0]?.description).toContain("Needle");
    expect(out.results[0]?.description?.length).toBeLessThan(long.length);
    expect(out.results[1]?.content).toContain("Needle");
    expect(out.results[1]?.userName).toBe("Ann");
  });

  it("passes through an answer without results", () => {
    expect(excerptSearchResults({ error: "x" }, "q")).toEqual({ error: "x" });
  });
});
