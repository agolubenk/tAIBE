import { redact } from "./index";

// TB-143: a caller that feeds a model (API key, agent key, MCP bearer) reads
// free text through redact. When it writes that text back, the markers are
// put back to the stored values, so a write-back never stores a marker in
// place of the original text.

// Kinds are not listed here: a kind that redact adds later is a marker too.
const MARKER = /\[REDACTED:([a-z0-9_]+)\]/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return redact(value).text;
  if (Array.isArray(value)) return value.map(walk);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = walk(item);
    return out;
  }
  // Numbers, booleans, null and class instances (Date) keep their value.
  return value;
}

/** Every string at any depth of plain objects and arrays goes through redact. */
export function redactDeep<T>(value: T): T {
  return walk(value) as T;
}

export function hasRedactionMarker(text: string): boolean {
  return /\[REDACTED:[a-z0-9_]+\]/.test(text);
}

type Original = { start: number; end: number; kind: string; value: string };

// What each marker of the masked view stands for, per kind, in text order:
// the secret for a redact hit, the marker itself for a marker that the
// stored text already holds literally.
function originalsByKind(stored: string): Map<string, string[]> {
  const { hits } = redact(stored);
  const items: Original[] = hits.map((hit) => ({
    ...hit,
    value: stored.slice(hit.start, hit.end),
  }));
  // Hits are sorted and do not overlap; a literal marker inside a hit is
  // part of that hit's value, not a marker of the masked view.
  let next = 0;
  for (const match of stored.matchAll(MARKER)) {
    const start = match.index;
    const end = start + match[0].length;
    while (next < hits.length && (hits[next]?.end ?? 0) <= start) next++;
    const hit = hits[next];
    if (hit && hit.start < end) continue;
    items.push({ start, end, kind: match[1] ?? "", value: match[0] });
  }
  items.sort((a, b) => a.start - b.start);

  const byKind = new Map<string, string[]>();
  for (const item of items) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item.value);
    byKind.set(item.kind, list);
  }
  return byKind;
}

export type RestoreResult =
  | { ok: true; text: string }
  | { ok: false; kind: string; expected: number; received: number };

/**
 * Puts the stored values back in place of the markers in `incoming`.
 * Text without markers is returned as is. If, for any kind, the number of
 * markers differs from the number of stored values, the order is ambiguous
 * and nothing is restored.
 */
export function restoreRedacted(
  stored: string,
  incoming: string,
): RestoreResult {
  if (!hasRedactionMarker(incoming)) return { ok: true, text: incoming };

  const originals = originalsByKind(stored);
  const received = new Map<string, number>();
  for (const match of incoming.matchAll(MARKER)) {
    const kind = match[1] ?? "";
    received.set(kind, (received.get(kind) ?? 0) + 1);
  }
  for (const kind of new Set([...originals.keys(), ...received.keys()])) {
    const expected = originals.get(kind)?.length ?? 0;
    const count = received.get(kind) ?? 0;
    if (expected !== count) {
      return { ok: false, kind, expected, received: count };
    }
  }

  const used = new Map<string, number>();
  const text = incoming.replace(MARKER, (marker, kind: string) => {
    const index = used.get(kind) ?? 0;
    used.set(kind, index + 1);
    return originals.get(kind)?.[index] ?? marker;
  });
  return { ok: true, text };
}
