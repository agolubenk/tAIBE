import { SEED_TRUNCATED } from "../fell/build-seeds";

// Felling cuts text at a fixed length, maybe inside a secret, and redact does
// not know a secret without its end. So a cut text is read only up to the
// last whitespace before the cut (backend lens #388, R2; TB-203). The rule
// runs on read, so logs felled before it are covered too.
export function upToLastSpace(text: string) {
  const lastSpace = text.search(/\s\S*$/);
  return lastSpace < 0 ? "" : text.slice(0, lastSpace);
}

// A text cut at `max` characters: a history entry, a field of the search
// text (searched-parts.ts). A text
// of exactly `max` characters that was not cut loses its last word.
export function uncutText(text: string, max: number) {
  return text.length < max ? text : upToLastSpace(text);
}

// A clip mark: `…` that ends a line or the text, as felling puts it after a
// clipped description or comment of a seed.
const CLIP_MARK = /…(?=\n|$)/g;

// A seed body: each clipped piece before its mark, and the body before the
// mark of its own cut (SEED_TRUNCATED). A word that ends a line with `…` of
// its own is lost too.
export function uncutClips(body: string) {
  const truncated = body.endsWith(SEED_TRUNCATED);
  const kept = truncated
    ? upToLastSpace(body.slice(0, -SEED_TRUNCATED.length))
    : body;
  let result = "";
  let cursor = 0;
  for (const mark of kept.matchAll(CLIP_MARK)) {
    result += `${upToLastSpace(kept.slice(cursor, mark.index))}…`;
    cursor = mark.index + 1;
  }
  return result + kept.slice(cursor) + (truncated ? SEED_TRUNCATED : "");
}
