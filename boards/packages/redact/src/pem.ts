import type { Detector, RedactHit } from "./index";

// PEM blocks end in "KEY-----", PGP key blocks in "KEY BLOCK-----".
// A BEGIN line up to the nearest END line. Not one lazy regex: from every
// BEGIN without an END it scans to the end of the text, so 256 KB of BEGIN
// lines took 1.3 s (TB-136 security lens). If a BEGIN has no END after it, a
// later BEGIN has none either, so that search is not done again.
//
// TB-203 N4: a block cut on one side (a chunk window, a clip, a paste) still
// holds key lines, and base64Blob misses a line shorter than 64. A BEGIN
// with no END after it is masked up to the first blank line or the end of
// the text; an END with no BEGIN before it (since the last hit), from the
// last blank line or the last hit. Every search goes on from where the last
// one stopped, so the pass stays linear.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z0-9 ]*KEY(?: BLOCK)?-----/g;
const BLANK_LINE = /\n[ \t]*\r?\n/g;

// The first match of `pattern` at or after `from`. A kept match at or after
// `from` is reused, a kept null (none after an earlier point) is final.
function matchFrom(
  pattern: RegExp,
  text: string,
  from: number,
  kept: RegExpExecArray | null | undefined,
): RegExpExecArray | null {
  if (kept === null || (kept && kept.index >= from)) return kept;
  pattern.lastIndex = from;
  return pattern.exec(text);
}

export const pem: Detector = (text) => {
  const hits: RedactHit[] = [];
  let at = 0;
  let begin: RegExpExecArray | null | undefined;
  let end: RegExpExecArray | null | undefined;
  let blank: RegExpExecArray | null | undefined;
  const blankFrom = (from: number) =>
    (blank = matchFrom(BLANK_LINE, text, from, blank));
  for (;;) {
    begin = matchFrom(PEM_BEGIN, text, at, begin);
    end = matchFrom(PEM_END, text, at, end);
    if (end && (!begin || end.index < begin.index)) {
      // From the end of the last blank line before the END, or `at`.
      let start = at;
      for (
        let line = blankFrom(at);
        line && line.index < end.index;
        line = blankFrom(start)
      ) {
        start = line.index + line[0].length;
      }
      const stop = end.index + end[0].length;
      hits.push({ kind: "pem", start, end: stop });
      at = stop;
      continue;
    }
    if (!begin) break;
    const opened = begin.index + begin[0].length;
    // An END that starts inside the BEGIN line is not its END.
    end = matchFrom(PEM_END, text, opened, end);
    let stop: number;
    if (end) {
      stop = end.index + end[0].length;
    } else {
      stop = blankFrom(opened)?.index ?? text.length;
    }
    hits.push({ kind: "pem", start: begin.index, end: stop });
    at = stop;
  }
  return hits;
};
