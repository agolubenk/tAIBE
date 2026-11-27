import { isRecord } from "./entity.js";

const RADIUS = 80;
const TEXT_KEYS = ["description", "content"] as const;

// Where q is in the text: the whole query, else the first of its words.
// Search finds each word of q in any order (TB-162), so the whole query is
// often not in the text.
function matchAt(lower: string, needle: string): [at: number, length: number] {
  const whole = lower.indexOf(needle);
  if (whole >= 0) return [whole, needle.length];
  let best: [number, number] = [-1, 0];
  for (const word of needle.split(" ")) {
    const at = lower.indexOf(word);
    if (at >= 0 && (best[0] < 0 || at < best[0])) best = [at, word.length];
  }
  return best;
}

// A window around the first match of q, whitespace collapsed, so a search hit
// shows why it matched without carrying the whole description (R-031).
export function excerptAround(text: string, q: string, radius = RADIUS) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= radius * 2) return flat;
  const needle = q.replace(/\s+/g, " ").trim().toLowerCase();
  const [at, length] = needle ? matchAt(flat.toLowerCase(), needle) : [-1, 0];
  if (at < 0) return `${flat.slice(0, radius * 2)}…`;
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + length + radius);
  const head = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  return `${head}${flat.slice(start, end)}${tail}`;
}

export function excerptSearchResults(data: unknown, q: string): unknown {
  if (!isRecord(data) || !Array.isArray(data.results)) return data;
  const results = data.results.map((result: unknown) => {
    if (!isRecord(result)) return result;
    const next = { ...result };
    for (const key of TEXT_KEYS) {
      const value = next[key];
      if (typeof value === "string") next[key] = excerptAround(value, q);
    }
    return next;
  });
  return { ...data, results };
}
