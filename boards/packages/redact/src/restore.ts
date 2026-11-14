import { redact } from "./index";

// TB-143: a caller that feeds a model (API key, agent key, MCP bearer) reads
// free text through redact. When it writes that text back, the markers are
// put back to the stored values, so a write-back never stores a marker in
// place of the original text.

// Kinds are not listed here: a kind that redact adds later is a marker too.
const MARKER = /\[REDACTED:([a-z0-9_]+)\]/g;

// Blocks are split on blank lines. In CommonMark a blank line ends every
// inline construct (link, image, autolink, inline HTML), so a block that
// comes back byte for byte cannot move its secret into a URL.
const BLOCK_SEPARATOR = /(\r?\n[ \t]*\r?\n)/;

// What can run across blank lines and pull a later block into a URL:
// - raw HTML: a renderer copies an HTML block as is, and the browser reads
//   an open attribute (`<div>` + `<img src="https://x/?k=`) on into the next
//   blocks, whatever the markdown block boundaries are;
// - a code fence (```math, diagram fences) and a `$$` math block.
const OPENS_CONTEXT = /<[a-z!?/]|^[ \t>*+\-0-9.)]*(?:`{3,}|~{3,})|\$\$/im;

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

type Marker = { kind: string; original: string };
type Item = { start: number; end: number; marker: Marker; hit: boolean };

// The masked view of the stored text, as a caller with a token reads it,
// and what each of its markers stands for, in text order: the secret for a
// redact hit, the marker itself for a marker the stored text holds literally.
function maskedView(stored: string): { text: string; markers: Marker[] } {
  const { hits } = redact(stored);
  const items: Item[] = hits.map((hit) => ({
    start: hit.start,
    end: hit.end,
    hit: true,
    marker: { kind: hit.kind, original: stored.slice(hit.start, hit.end) },
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
    items.push({
      start,
      end,
      hit: false,
      marker: { kind: match[1] ?? "", original: match[0] },
    });
  }
  items.sort((a, b) => a.start - b.start);

  let text = "";
  let cursor = 0;
  for (const item of items) {
    text += stored.slice(cursor, item.start);
    text += item.hit ? `[REDACTED:${item.marker.kind}]` : item.marker.original;
    cursor = item.end;
  }
  text += stored.slice(cursor);
  return { text, markers: items.map((item) => item.marker) };
}

function countKinds(kinds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return counts;
}

const markerKinds = (text: string) =>
  [...text.matchAll(MARKER)].map((match) => match[1] ?? "");

type StoredBlock = { offset: number; markers: Marker[] };
// `next` is the copy the next equal incoming block takes, in text order.
type BlockCopies = { copies: StoredBlock[]; next: number; ambiguous: boolean };

const sameValues = (a: Marker[], b: Marker[]) =>
  a.length === b.length &&
  a.every((marker, index) => marker.original === b[index]?.original);

// Each block of the masked view that holds markers: where it starts and
// what its markers stand for. Equal blocks are kept in text order; they are
// ambiguous if their copies stand for different values (TB-143 B2).
function markerBlocks(view: {
  text: string;
  markers: Marker[];
}): Map<string, BlockCopies> {
  const blocks = new Map<string, BlockCopies>();
  let offset = 0;
  let index = 0;
  for (const part of view.text.split(BLOCK_SEPARATOR)) {
    const count = markerKinds(part).length;
    if (count > 0) {
      const block = {
        offset,
        markers: view.markers.slice(index, index + count),
      };
      const entry = blocks.get(part);
      if (entry) {
        const first = entry.copies[0];
        if (first && !sameValues(first.markers, block.markers)) {
          entry.ambiguous = true;
        }
        entry.copies.push(block);
      } else {
        blocks.set(part, { copies: [block], next: 0, ambiguous: false });
      }
      index += count;
    }
    offset += part.length;
  }
  return blocks;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let length = 0;
  while (length < max && a.charCodeAt(length) === b.charCodeAt(length)) {
    length++;
  }
  return length;
}

/**
 * The longest text with markers that is restored (TB-143 B3). Restoring is
 * linear in the text, but the text goes through redact three times on a
 * write; a longer text is refused before any of that work.
 */
export const RESTORE_MAX_CHARS = 256 * 1024;

export type RestoreResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: "count";
      kind: string;
      expected: number;
      received: number;
    }
  | { ok: false; reason: "size"; max: number }
  | { ok: false; reason: "block" | "context" | "ambiguous" | "mask" };

/**
 * Puts the stored values back in place of the markers in `incoming`.
 * Text without markers is returned as is. Otherwise, nothing is restored if:
 * - the text is longer than `RESTORE_MAX_CHARS` (`size`);
 * - a kind has a different number of markers than stored values (`count`);
 * - a block (paragraph) that holds a marker is not byte for byte a block of
 *   the masked stored text: the marker moved or its block changed (`block`);
 * - the text above a block with a marker is not the stored text above it and
 *   holds raw HTML, a code fence or `$$` (`context`);
 * - equal blocks with markers stand for different values and the text above
 *   one of them changed, so the values could change places (`ambiguous`);
 * - the restored text does not mask back to what the caller sent: a value
 *   lost the context that masks it, e.g. `password:` in an edited block
 *   above (`mask`).
 */
export function restoreRedacted(
  stored: string,
  incoming: string,
): RestoreResult {
  if (!hasRedactionMarker(incoming)) return { ok: true, text: incoming };
  if (incoming.length > RESTORE_MAX_CHARS) {
    return { ok: false, reason: "size", max: RESTORE_MAX_CHARS };
  }

  const view = maskedView(stored);
  const expected = countKinds(view.markers.map((marker) => marker.kind));
  const received = countKinds(markerKinds(incoming));
  for (const kind of new Set([...expected.keys(), ...received.keys()])) {
    const want = expected.get(kind) ?? 0;
    const count = received.get(kind) ?? 0;
    if (want !== count) {
      return {
        ok: false,
        reason: "count",
        kind,
        expected: want,
        received: count,
      };
    }
  }

  const blocks = markerBlocks(view);
  // Computed once (TB-143 B3): the text above a block at `offset` is the
  // stored text above it if both start there and the texts agree up to it;
  // it holds raw HTML, a fence or `$$` if the first of them starts before
  // it. No match crosses a block boundary: the separator ends with a line
  // break, which none of them holds.
  const unchangedUpTo = commonPrefixLength(incoming, view.text);
  const context = incoming.search(OPENS_CONTEXT);
  const contextAt = context === -1 ? Number.POSITIVE_INFINITY : context;

  let out = "";
  let offset = 0;
  for (const part of incoming.split(BLOCK_SEPARATOR)) {
    if (hasRedactionMarker(part)) {
      const entry = blocks.get(part);
      const block = entry?.copies[entry.next++];
      if (!entry || !block) return { ok: false, reason: "block" };
      const aboveUnchanged = offset === block.offset && unchangedUpTo >= offset;
      if (!aboveUnchanged && entry.ambiguous) {
        return { ok: false, reason: "ambiguous" };
      }
      if (!aboveUnchanged && contextAt < offset) {
        return { ok: false, reason: "context" };
      }
      let used = 0;
      out += part.replace(
        MARKER,
        (marker) => block.markers[used++]?.original ?? marker,
      );
    } else {
      out += part;
    }
    offset += part.length;
  }

  // TB-143 B1: the masked read of what is stored must be what the caller
  // sent, or a raw secret the caller typed, masked. Otherwise a restored
  // value is no longer masked, and the next read would show it.
  const masked = redact(out).text;
  if (masked !== incoming && masked !== redact(incoming).text) {
    return { ok: false, reason: "mask" };
  }
  return { ok: true, text: out };
}
