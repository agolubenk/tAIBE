import { decode as toonDecode, encode as toonEncode } from "@toon-format/toon";
import { encode as o200kEncode } from "gpt-tokenizer/encoding/o200k_base";

export type WireFormat = "toon" | "json";

export interface TokenCounter {
  name: string;
  count(text: string): number;
}

// Proposal D-018: o200k_base via gpt-tokenizer. It sits behind TokenCounter
// so the decision can be revisited with a one-line change. The name carries
// the pinned version; src/token-reference.test.ts holds the reference counts.
export const defaultCounter: TokenCounter = {
  name: "gpt-tokenizer@4.1.0/o200k_base",
  count: (text) => o200kEncode(text).length,
};

export function encodeResponse(
  value: unknown,
  opts?: { format?: WireFormat },
): { text: string; format: WireFormat; fallbackError?: string } {
  const format = opts?.format ?? "toon";
  if (format === "json") {
    return { text: JSON.stringify(value, null, 2), format };
  }
  try {
    return { text: toonEncode(value), format };
  } catch (error) {
    return {
      text: JSON.stringify(value, null, 2),
      format: "json",
      fallbackError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function decodeResponse(text: string, format: WireFormat): unknown {
  return format === "toon" ? toonDecode(text) : JSON.parse(text);
}

export const MIN_BUDGET = 150;
export const MAX_BUDGET = 2500;
const TRUNCATION_NOTE = "… [truncated]";

type JsonContainer = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is JsonContainer {
  return typeof value === "object" && value !== null;
}

function deepClone(value: unknown): unknown {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// Longest-first progressive string shortening across the whole structure:
// each pass halves the longest string, so repeated passes converge below any
// budget that a bare skeleton can satisfy.
const MIN_STRING_FLOOR = 64;
// Below 2 * floor, halving lands back on floor + note and makes no progress;
// such strings are left alone so the loop moves on to trimming arrays.
const MIN_SHORTENABLE_LENGTH = 2 * MIN_STRING_FLOOR;

function shortenLongestString(root: JsonContainer): boolean {
  let target: {
    holder: Record<string, unknown> | unknown[];
    key: string | number;
  } | null = null;
  let longest = MIN_SHORTENABLE_LENGTH - 1;
  const visit = (
    node: unknown,
    holder: Record<string, unknown> | unknown[],
    key: string | number,
  ) => {
    if (typeof node === "string" && node.length > longest) {
      longest = node.length;
      target = { holder, key };
      return;
    }
    if (isContainer(node)) {
      for (const [childKey, child] of Object.entries(node)) {
        visit(child, node as Record<string, unknown> | unknown[], childKey);
      }
    }
  };
  for (const [key, child] of Object.entries(root)) {
    visit(child, root, key);
  }
  if (!target) return false;
  const { holder, key } = target;
  const current = String((holder as Record<string | number, unknown>)[key]);
  (holder as Record<string | number, unknown>)[key] =
    `${current.slice(0, Math.max(MIN_STRING_FLOOR, Math.floor(current.length / 2)))}${TRUNCATION_NOTE}`;
  return true;
}

// Halve the longest array anywhere in the structure.
function trimLongestArray(root: JsonContainer): boolean {
  let target: unknown[] | null = null;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      if (node.length > 1 && (!target || node.length > target.length)) {
        target = node;
      }
      for (const child of node) visit(child);
      return;
    }
    if (isContainer(node)) {
      for (const child of Object.values(node)) visit(child);
    }
  };
  visit(root);
  if (!target) return false;
  const array: unknown[] = target;
  array.length = Math.max(1, Math.floor(array.length / 2));
  return true;
}

function attachFullRef(value: unknown, fullRef: string): JsonContainer {
  if (isContainer(value) && !Array.isArray(value)) {
    return { ...value, truncated: true, fullRef };
  }
  return { value, truncated: true, fullRef };
}

export function fitToBudget(
  value: unknown,
  opts: {
    budget?: number;
    format?: WireFormat;
    fullRef: string;
    counter?: TokenCounter;
  },
): { text: string; format: WireFormat; tokens: number; truncated: boolean } {
  const format = opts?.format ?? "toon";
  const counter = opts?.counter ?? defaultCounter;
  const budget = Math.min(
    MAX_BUDGET,
    Math.max(MIN_BUDGET, opts?.budget ?? MAX_BUDGET),
  );

  const initial = encodeResponse(value, { format });
  const initialTokens = counter.count(initial.text);
  if (initialTokens <= budget) {
    return {
      text: initial.text,
      format: initial.format,
      tokens: initialTokens,
      truncated: false,
    };
  }

  const working = deepClone(value);
  // fullRef rides along from the start, so the measured text always
  // includes it and truncation cannot cut it away afterwards.
  const candidate = attachFullRef(
    isContainer(working) ? working : { value: working },
    opts.fullRef,
  );

  // Structural truncation only: shorten long Markdown strings first, then
  // trim array tails. The serialized text is never cut mid-stream.
  for (let guard = 0; guard < 1000; guard += 1) {
    const encoded = encodeResponse(candidate, { format });
    const tokens = counter.count(encoded.text);
    if (tokens <= budget) {
      return {
        text: encoded.text,
        format: encoded.format,
        tokens,
        truncated: true,
      };
    }
    if (!shortenLongestString(candidate) && !trimLongestArray(candidate)) {
      return {
        text: encoded.text,
        format: encoded.format,
        tokens,
        truncated: true,
      };
    }
  }

  const finalEncoded = encodeResponse(candidate, { format });
  return {
    text: finalEncoded.text,
    format: finalEncoded.format,
    tokens: counter.count(finalEncoded.text),
    truncated: true,
  };
}
