import { describe, expect, it } from "vite-plus/test";
import { redact as baseRedact } from "../fixtures/redact-base";
import { redact, type RedactHit } from "./index";

// Coord, #375 (TB-198): a change of the search may only add masks. Every
// character that the base (fixtures/redact-base.ts) masks, redact() masks
// too. Seeded cases, two templates in turn, each with a value at the end:
// - a chain of junk, names and separators, up to 6 deep;
// - nested rewinds: 1-3 names behind a DROPS_VALUE character, then 1-3
//   names in a row (A_TOKEN=x(B_TOKEN = y(C_TOKEN = D1_TOKEN = <v>).
// CI runs 20 000 cases (about 1 s). Measured on 20 seeds: a head with only
// the nested-rewind loss of #375 2a50b88f4 (B1) loses a mask in 2-8 cases
// on every seed; chains alone found it on 5 seeds of 20. The PR body has
// 4 seeds x 200 000.
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

function generator(seed: number): () => string {
  let state = seed;
  let turn = 0;
  const pick = <T>(items: readonly T[]): T => {
    state = (state * 48_271) % 2_147_483_647;
    return items[state % items.length] as T;
  };
  const repeat = (times: number, part: () => string) =>
    Array.from({ length: times }, part).join("");
  const name = () => pick(NAMES) + pick(SEPARATORS);
  const value = () => pick(["", '"']) + pick(VALUES) + pick(ENDS);
  const chain = () =>
    repeat(pick([1, 2, 3, 4, 5, 6]), () => pick(JUNK) + name()) + value();
  const nested = () =>
    name() +
    repeat(pick([1, 2, 3]), () => pick(DROPPING) + name()) +
    repeat(pick([1, 2, 3]), name) +
    value();
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

describe("redact masks a superset of the base", () => {
  it(`keeps every base mask on ${CASES} seeded chains`, () => {
    const next = generator(SEED);
    const lost: string[] = [];
    let baseMasks = 0;
    let added = 0;
    for (let index = 0; index < CASES; index += 1) {
      const text = next();
      const base = maskedBy(baseRedact(text).hits, text.length);
      const head = maskedBy(redact(text).hits, text.length);
      if (base.includes(true)) baseMasks += 1;
      if (base.some((on, at) => on && !head[at])) lost.push(text);
      else if (head.some((on, at) => on && !base[at])) added += 1;
    }
    expect(lost.slice(0, 5)).toEqual([]);
    // The generator is not vacuous: the base masks most cases, and the
    // search of TB-198 adds masks to some.
    expect(baseMasks).toBeGreaterThan(CASES / 2);
    expect(added).toBeGreaterThan(0);
  });
});
