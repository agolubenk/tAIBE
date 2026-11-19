import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vite-plus/test";
import { defaultCounter, encodeResponse, type WireFormat } from "./index";

// TB-18 (D-018): token budgets of every MCP answer come from defaultCounter.
// If a tokenizer upgrade counts differently, budgets and cuts move silently,
// and measurements before and after stop being comparable. The reference
// cards fix the counts: a drift fails here, so a counter change is a
// decision. To change the counter on purpose, regenerate
// examples/token-reference.json and give the new counts in the PR.

interface ReferenceCard {
  name: string;
  format: WireFormat | "text";
  value?: unknown;
  text: string;
  tokens: number;
}

const reference = JSON.parse(
  readFileSync(
    new URL("../examples/token-reference.json", import.meta.url),
    "utf8",
  ),
) as { counter: string; cards: ReferenceCard[] };

const label = (card: ReferenceCard) => `${card.name} (${card.format})`;

describe("token counter reference cards", () => {
  it("were counted by the current counter", () => {
    expect(reference.counter).toBe(defaultCounter.name);
  });

  it("cover TOON, JSON, plain text and an empty text", () => {
    const formats = new Set(reference.cards.map((card) => card.format));
    expect(formats).toEqual(new Set(["toon", "json", "text"]));
    expect(reference.cards.some((card) => card.text === "")).toBe(true);
  });

  it.each(reference.cards.map((card) => [label(card), card] as const))(
    "%s keeps its token count",
    (_, card) => {
      expect(defaultCounter.count(card.text)).toBe(card.tokens);
    },
  );

  it.each(
    reference.cards
      .filter((card) => card.format !== "text")
      .map((card) => [label(card), card] as const),
  )("%s is still encoded to the same text", (_, card) => {
    const encoded = encodeResponse(card.value, {
      format: card.format as WireFormat,
    });
    expect(encoded.format).toBe(card.format);
    expect(encoded.text).toBe(card.text);
  });
});

describe("token counter version", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> };
  const pinned = manifest.dependencies["gpt-tokenizer"];

  it("is an exact pin, not a range", () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is the installed version and is named by the counter", () => {
    const installed = (
      createRequire(import.meta.url)("gpt-tokenizer/package.json") as {
        version: string;
      }
    ).version;
    expect(installed).toBe(pinned);
    expect(defaultCounter.name).toBe(`gpt-tokenizer@${pinned}/o200k_base`);
  });
});
