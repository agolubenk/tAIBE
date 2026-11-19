import type { Detector, RedactHit } from "./index.js";

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

// A BEGIN can share the dashes of the END before it (`KEY-----BEGIN`, 5-9
// dashes). The next search starts at that BEGIN, not after the END: from
// there it found no BEGIN, and the body of the block stayed open (tools lens
// #400 B1). `next` starts after the END's start, so `at` still grows.
function nextFrom(stop: number, next: RegExpExecArray | null | undefined) {
  return next && next.index < stop ? next.index : stop;
}

// Coord 11:05 (boards #400 N1): the blocks of the detector before TB-203
// are masked too. Its form is the same in be1b3ffe1, 2dd520685 and
// 221e381b4. So every block that it masks stays masked, whatever pairing the
// search above reads in glued lines. redact() merges overlapping hits. One
// more linear pass: each search goes on after the last END.
function pairedBlocks(text: string): RedactHit[] {
  const hits: RedactHit[] = [];
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin; begin = PEM_BEGIN.exec(text)) {
    PEM_END.lastIndex = PEM_BEGIN.lastIndex;
    if (!PEM_END.exec(text)) break;
    hits.push({ kind: "pem", start: begin.index, end: PEM_END.lastIndex });
    PEM_BEGIN.lastIndex = PEM_END.lastIndex;
  }
  return hits;
}

export const pem: Detector = (text) =>
  cutBlocks(text).concat(pairedBlocks(text));

function cutBlocks(text: string): RedactHit[] {
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
      at = nextFrom(stop, begin);
      continue;
    }
    if (!begin) break;
    const start = begin.index;
    let opened = start + begin[0].length;
    // A BEGIN can start inside this BEGIN line, on its dashes
    // (`KEY-----BEGIN`). Then the block opens at the end of the last such
    // BEGIN: an END glued to it was not its END, and the body after it
    // stayed open (role 4 #400 B1).
    for (
      let glued = matchFrom(PEM_BEGIN, text, begin.index + 1, begin);
      glued && glued.index < opened;
      glued = matchFrom(PEM_BEGIN, text, glued.index + 1, glued)
    ) {
      opened = Math.max(opened, glued.index + glued[0].length);
      begin = glued;
    }
    // An END that starts inside the BEGIN line is not its END.
    end = matchFrom(PEM_END, text, opened, end);
    if (end) {
      const stop = end.index + end[0].length;
      begin = matchFrom(PEM_BEGIN, text, end.index + 1, begin);
      hits.push({ kind: "pem", start, end: stop });
      at = nextFrom(stop, begin);
    } else {
      const stop = blankFrom(opened)?.index ?? text.length;
      hits.push({ kind: "pem", start, end: stop });
      at = stop;
    }
  }
  return hits;
}
