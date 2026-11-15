import { describe, expect, it } from "vite-plus/test";
import { redact as baseRedact } from "../fixtures/redact-base";
import { redact as base378Redact } from "../fixtures/redact-base-221e381b4";
import { redact, type RedactHit } from "./index";

// Coord, #375 (TB-198): a change of the search may only add masks. Every
// character of a secret value that a base masks, redact() masks too. Two
// frozen bases, never edited: fixtures/redact-base.ts (src/index.ts at
// 2dd520685, before TB-198) and fixtures/redact-base-221e381b4.ts (src/
// index.ts at 221e381b4, after #375 and #378, byte for byte, TB-202).
//
// The seeded test compares only the characters of the value at the end of
// each case. TB-199 drops base masks that cover no value on purpose (a
// separator character, a name): the second test lists them. Seeded cases,
// two templates in turn:
// - a chain of junk, names and separators, up to 6 deep;
// - nested rewinds: 1-3 names behind a DROPS_VALUE character, then 1-3
//   names in a row (A_TOKEN=x(B_TOKEN = y(C_TOKEN = D1_TOKEN = <v>).
// CI runs 20 000 cases (about 1 s). Measured on 20 seeds: a head with only
// the nested-rewind loss of #375 2a50b88f4 (B1) loses a mask in 2-8 cases
// on every seed; chains alone found it on 5 seeds of 20. The glued `==`
// separators find release #392 B1 (`DB_PASSWORD==<v>` left open): about
// 4 000 of 200 000 cases. The PR body has 4 seeds x 200 000.
const CASES = 20_000;
const SEED = 11;

const NAMES = [
  "A_TOKEN",
  "B_TOKEN",
  "C_TOKEN",
  "D1_TOKEN",
  "X1_TOKEN",
  "GITHUB_TOKEN",
  "GH2_TOKEN",
  "T_ACCESS_TOKEN",
  "api_key",
  "k1_api_key",
  "x-api-key",
  "API_KEY",
  "A_SECRET",
  "B_SECRET",
  "C_PASSWORD",
  "secret",
  "password",
  "passwd",
];
const SEPARATORS = [
  "=",
  " = ",
  ":",
  " : ",
  ": ",
  '"=',
  '" = "',
  '": "',
  "=\t",
  ":=",
  "=>",
  " => ",
  "==",
  "===",
];
const JUNK = [
  "",
  " ",
  "x",
  "x(",
  "y(",
  "(",
  "x)",
  "x;",
  "q;",
  "x.",
  "a=",
  "é",
  '"',
  "'",
  "foo",
  "abc",
  "a b",
  "aaaa/",
  "{{vault}}/",
];
// Each holds a DROPS_VALUE character: a value with it is rejected.
const DROPPING = ["x(", "y(", "(", "x)", "x;", "q;", "é"];
const VALUES = [
  ["Qz8Lm4", "Rt7Wx2", "Ny5Kp9Bv"].join(""),
  ["Correct", "Horse", "Battery", "Staple"].join(""),
  ["correct", "horse", "battery", "staple"].join(""),
];
const ENDS = ["", '"', ";", ")", " tail"];

type Case = { text: string; start: number; end: number };

function generator(seed: number): () => Case {
  let state = seed;
  let turn = 0;
  const pick = <T>(items: readonly T[]): T => {
    state = (state * 48_271) % 2_147_483_647;
    return items[state % items.length] as T;
  };
  const repeat = (times: number, part: () => string) =>
    Array.from({ length: times }, part).join("");
  const name = () => pick(NAMES) + pick(SEPARATORS);
  const value = (before: string): Case => {
    const quote = pick(["", '"']);
    const secret = pick(VALUES);
    const start = before.length + quote.length;
    const text = before + quote + secret + pick(ENDS);
    return { text, start, end: start + secret.length };
  };
  const chain = () =>
    value(repeat(pick([1, 2, 3, 4, 5, 6]), () => pick(JUNK) + name()));
  const nested = () =>
    value(
      name() +
        repeat(pick([1, 2, 3]), () => pick(DROPPING) + name()) +
        repeat(pick([1, 2, 3]), name),
    );
  return () => {
    turn += 1;
    return turn % 2 ? chain() : nested();
  };
}

function maskedBy(hits: RedactHit[], length: number): boolean[] {
  const masked = Array.from({ length }, () => false);
  for (const hit of hits) masked.fill(true, hit.start, hit.end);
  return masked;
}

const BASES = [
  { name: "2dd520685", redact: baseRedact },
  { name: "221e381b4", redact: base378Redact },
];

describe("redact masks a superset of the base", () => {
  it.each(BASES)(
    `keeps every $name value mask on ${CASES} seeded chains`,
    (b) => {
      const next = generator(SEED);
      const lost: string[] = [];
      let baseMasks = 0;
      let added = 0;
      let glued = 0;
      for (let index = 0; index < CASES; index += 1) {
        const { text, start, end } = next();
        const base = maskedBy(b.redact(text).hits, text.length).slice(
          start,
          end,
        );
        const head = maskedBy(redact(text).hits, text.length).slice(start, end);
        if (base.includes(true)) baseMasks += 1;
        if (/[^=]==/.test(text)) glued += 1;
        if (base.some((on, at) => on && !head[at])) lost.push(text);
        else if (head.some((on, at) => on && !base[at])) added += 1;
      }
      expect(lost.slice(0, 5)).toEqual([]);
      // The generator is not vacuous: the base masks the value in 36-44 % of
      // the cases, the head masks it in some more (TB-198 against 2dd520685,
      // TB-199 against 221e381b4), and many cases hold a glued `==`.
      expect(baseMasks).toBeGreaterThan(CASES / 4);
      expect(added).toBeGreaterThan(0);
      expect(glued).toBeGreaterThan(CASES / 10);
    },
  );

  // TB-199 drops these masks of 221e381b4 on purpose; none covers a value.
  // [start, text] of each run that the base masks and the head does not.
  const value = VALUES[0] as string;
  it.each([
    // The base took `=` of `:=` or `>` of `=>` as the value.
    ["password := <v>", [[10, "="]]],
    ["'password' => '<v>'", [[12, ">"]]],
    // A comparison is not an assignment.
    ["if (password === true) run()", [[13, "=="]]],
    ["x.password == y", [[11, "="]]],
    // The base masked the first place equal to the value, in the name.
    ["password: pass", [[0, "pass"]]],
    ["{ password: password }", [[2, "password"]]],
    // A glued `==` keeps the mask of the base (release #392 B1).
    ["PASSWORD==<v>", []],
    ["api_key===<v>", []],
    ['GITHUB_TOKEN := "<v>"', []],
  ] as const)("drops only the listed 221e381b4 masks in %j", (input, runs) => {
    const text = input.replace("<v>", value);
    const base = maskedBy(base378Redact(text).hits, text.length);
    const head = maskedBy(redact(text).hits, text.length);
    const dropped: [number, string][] = [];
    for (let at = 0; at < text.length;) {
      if (!base[at] || head[at]) {
        at += 1;
        continue;
      }
      let end = at;
      while (end < text.length && base[end] && !head[end]) end += 1;
      dropped.push([at, text.slice(at, end)]);
      at = end;
    }
    expect(dropped).toEqual(runs);
    if (input.includes("<v>")) expect(redact(text).text).not.toContain(value);
  });
});
