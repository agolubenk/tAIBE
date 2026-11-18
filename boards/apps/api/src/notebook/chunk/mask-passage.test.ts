import type { RedactHit } from "@kaneo/redact";
import { describe, expect, it, vi } from "vite-plus/test";
import { maskPassage } from "./mask-chunk-edges";

// A fake redact. Its second reading finds what the first one cannot: a word
// right after a marker, and an `x` glued to a marker. So each such hit lies
// over or after a marker, and maskPassage must map it back to the
// characters of the passage. With the real redact of this branch both
// readings hid the same values in 900 000 probe texts; with the one of #388
// they did not.
vi.mock("@kaneo/redact", () => ({
  redact: (text: string) => {
    const hits: RedactHit[] = [];
    for (const match of text.matchAll(
      /SEC\d|\] (\w+)|x\[REDACTED:api_key\]/dg,
    )) {
      const [start, end] = match.indices?.[1] ?? match.indices?.[0] ?? [0, 0];
      hits.push({ kind: "api_key", start, end });
    }
    return { text, hits };
  },
}));

describe("maskPassage maps the second reading back (boards #388 N1)", () => {
  it("masks a word that only the second reading finds after a marker", () => {
    expect(maskPassage("Заметки", "a SEC1 next b")).toBe(
      "Заметки\n\na [REDACTED:api_key] [REDACTED:api_key] b",
    );
  });

  it("masks the whole hit that a marker stands for", () => {
    expect(maskPassage("H", "xSEC2 c")).toBe("H\n\n[REDACTED:api_key] c");
  });

  // Claude lens #400 B2: without a heading the text was read once, and the
  // base read it twice (redact(redact(text).text)).
  it("reads a text without a heading twice too", () => {
    expect(maskPassage("", "a SEC1 next")).toBe(
      "a [REDACTED:api_key] [REDACTED:api_key]",
    );
    expect(maskPassage("", "xSEC2 c")).toBe("[REDACTED:api_key] c");
  });
});
