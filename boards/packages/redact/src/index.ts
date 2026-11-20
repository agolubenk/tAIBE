import {
  codeName,
  DROPS_VALUE,
  looksLikePassphrase,
  looksLikeSecret,
} from "./value-shape.js";

export { looksLikePassphrase, looksLikeSecret } from "./value-shape.js";

import { pem } from "./pem.js";

export type SecretKind =
  | "api_key"
  | "jwt"
  | "pem"
  | "db_url"
  | "url_credentials"
  | "bearer"
  | "base64_blob"
  | "password_assignment";

export type RedactHit = { kind: SecretKind; start: number; end: number };

export type Detector = (text: string) => RedactHit[];

function collect(pattern: RegExp, kind: SecretKind): Detector {
  return (text) => {
    const hits: RedactHit[] = [];
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      hits.push({ kind, start, end: start + match[0].length });
    }
    return hits;
  };
}

function lastDropping(value: string): number {
  for (let i = value.length - 1; i >= 0; i--) {
    if (DROPS_VALUE.test(value.charAt(i))) return i;
  }
  return -1;
}

const NAME_CHAR = /[A-Za-z0-9_-]/;

// The start of the run of name characters that ends at `end`.
function nameStart(value: string, end: number): number {
  let start = end;
  while (start > 0 && NAME_CHAR.test(value.charAt(start - 1))) start -= 1;
  return start;
}

// A separator that can end a value. `:=` and `=>` come first: with only `=`
// cut, `A_TOKEN:=` has no name at its end, and an accepted value
// `A_TOKEN:=` (after `=>`) stopped the search before the real value
// (X1_TOKEN=>A_TOKEN:="<v>", TB-202 superset test against 221e381b4).
const TRAILING_SEPARATORS = [":=", "=>", ":", "="];

// The start of the run of name characters that ends the value (a final
// separator aside), or -1.
function trailingName(value: string): number {
  const separator = TRAILING_SEPARATORS.find((sep) => value.endsWith(sep));
  const end = value.length - (separator?.length ?? 0);
  const start = nameStart(value, end);
  return start < end ? start : -1;
}

// Where the search goes on in a rejected value: after its last DROPS_VALUE
// character. If that character is the `>` of `=>`, at the name before it:
// the name has its value after `=>` (x(B_TOKEN=><v>, TB-199).
function afterDropping(value: string, dropping: number): number {
  const arrow = value.charAt(dropping) === ">";
  return arrow && value.charAt(dropping - 1) === "="
    ? nameStart(value, dropping - 1)
    : dropping + 1;
}

// TB-201 (Claude lens #392, 3): text is masked twice on its way to a model.
// In `password:=[REDACTED…]` the pattern fell back from `:=` to `:` with the
// value `=[REDACTED…]` (`>` of `=>` the same): the rest of a separator
// before a mask is a part of it. The first pass sees no mask: no change. A
// value that goes on after the mask is a value (role 4 #401 N1).
const SEPARATOR_BEFORE_MASK = /^[=>:]+[ \t]*["'`]?\[REDACTED:[a-z_]+\]/;

// TB-199: before the new separators the base took the `=` of a glued `:=`
// into the value (A_TOKEN:=<v>), and a filter accepts any value with `=` in
// it that is long enough. A value right after `:=` or `=>` is also judged as
// the base judged it, so no value that the base masked loses its mask
// (coord, 15.11). After `=>` a name of code is not: the re-check masked
// GITHUB_TOKEN=>githubToken (TB-201, Claude lens #392, 1), and a word value
// of a Ruby hash or a PHP array keeps its mask (coord B1 #401).
function accepts(
  accept: (value: string, next: string) => boolean,
  text: string,
  start: number,
  value: string,
): boolean {
  const mask = SEPARATOR_BEFORE_MASK.exec(text.slice(start, start + 64));
  if (mask && mask[0].length >= value.length) return false;
  const next = text.charAt(start + value.length);
  if (accept(value, next)) return true;
  const operator = text.slice(Math.max(0, start - 2), start);
  if (operator === "=>" && codeName(value)) return false;
  return (operator === ":=" || operator === "=>") && accept(`=${value}`, next);
}

// Replaces only group 1 of each match, keeping the surrounding context
// (header name, assignment key, quotes) readable. `accept` also gets the
// character after the value ("" at the end of the text).
//
// TB-198: another name with its own value may start inside a value, and the
// plain search does not look inside a value it has passed. A second search
// goes on where another name may start:
// - in a rejected value, after its last DROPS_VALUE character
//   (B_SECRET="x(=C_SECRET=<v>). A value with `=` or `:` in it is not a
//   name of any shape, so a filter rejects it only for its length or for
//   such a character, and then every value that holds it too;
// - otherwise at the run of name characters that ends the value: that name
//   has its separator after the value, past a space or a quote
//   (A_TOKEN=x.B_TOKEN = <v>, A_SECRET=fooB_SECRET: <v>, Control #375).
// The second search may pair a name with another value than the plain one
// (A_TOKEN=x(B_TOKEN = y(C_TOKEN = D1_TOKEN = X1_TOKEN = <v>), so it only
// adds hits: the plain search runs as before, and redact() merges
// overlapping hits (coord, #375). `resumeIn` gives where it goes on in an
// accepted value (-1: after the match).
function collectGroup(
  pattern: RegExp,
  kind: SecretKind,
  group: number,
  accept: (value: string, next: string) => boolean = () => true,
  resumeIn: (value: string) => number = trailingName,
): Detector {
  // Flag `d` gives the group's own position. The first equal text in the
  // match may sit in the name: `password: pass` (TB-199).
  const search = new RegExp(pattern, `${pattern.flags.replace("d", "")}d`);
  return (text) => {
    const hits: RedactHit[] = [];
    search.lastIndex = 0;
    for (const match of text.matchAll(search)) {
      const value = match[group];
      const start = match.indices?.[group]?.[0];
      if (value === undefined || start === undefined) continue;
      if (!accepts(accept, text, start, value)) continue;
      hits.push({ kind, start, end: start + value.length });
    }
    return hits.concat(innerHits(text, search, kind, group, accept, resumeIn));
  };
}

// The second search of TB-198. An inner match can end after the outer value:
// its separator crosses the space or the quote that ends the outer value
// (A_TOKEN=x(B_TOKEN = C_TOKEN = <v>). Then the next search starts at the
// end of the outer value (`limit`) at the latest, as without the rewind.
// Each search starts after the start of the last match.
function innerHits(
  text: string,
  pattern: RegExp,
  kind: SecretKind,
  group: number,
  accept: (value: string, next: string) => boolean,
  resumeIn: (value: string) => number,
): RedactHit[] {
  const hits: RedactHit[] = [];
  let limit = -1;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const value = match[group];
    const start = match.indices?.[group]?.[0];
    if (value === undefined || start === undefined) continue;
    const accepted = accepts(accept, text, start, value);
    if (accepted) hits.push({ kind, start, end: start + value.length });
    const dropping = accepted ? -1 : lastDropping(value);
    if (dropping >= 0) limit = Math.max(limit, pattern.lastIndex);
    const resume =
      dropping >= 0 ? afterDropping(value, dropping) : resumeIn(value);
    if (resume >= 0) {
      pattern.lastIndex = Math.max(match.index + 1, start + resume);
    }
    if (match.index < limit && pattern.lastIndex > limit) {
      pattern.lastIndex = limit;
    }
  }
  return hits;
}

// The user and the password have at most 256 characters each: unbounded,
// they ran to the end of the text from every scheme of a "postgres://a:" run.
const dbUrl = collect(
  /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s"'`/:@]{0,256}:[^\s@"'`]{1,256}@[^\s"'`]+/gi,
  "db_url",
);

// TB-136: credentials in a URL of any other scheme (https, smtp, ftp): only
// the password goes, the user and the host stay readable. A database URL is
// one db_url hit already and wins the overlap. A scheme has at most 32
// characters: an open one scanned from every word of a long "a.a.a…" run.
const urlCredentials = collectGroup(
  /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'`/:@]+:(?!\[REDACTED)([^\s@"'`/]{6,})@[^\s"'`/]/gi,
  "url_credentials",
  1,
);

// The header also as a JSON key ("Authorization": "Bearer …", Claude lens
// #283 B3). `\s*` stays: a token in the block below its header is still
// masked, and restore (#292) relies on that.
//
// TB-201 (Claude lens #378): in `abcAuthorization:Bearer <v>` the header is
// in the token's value, and the second search went on after its name. It
// goes on at the first header name in the value: linear.
const headerIn = (value: string) => {
  const at = value.search(/authorization/i);
  return at >= 0 ? at : trailingName(value);
};
const bearer = collectGroup(
  /Authorization["']?\s*:\s*["']?Bearer\s+(?!\[REDACTED)([^\s"']+)/gi,
  "bearer",
  1,
  () => true,
  headerIn,
);

// TB-136: the header of the board's own API keys, like `bearer`. Keys issued
// before the tbk_ prefix are 64 letters with no format of their own. In code
// the header mostly carries a variable ("x-api-key": apiKey), hence the filter.
// The value stays on the header's line: `x-api-key:` with an empty value
// does not take the next header (Content-Type: …) as the key.
const apiKeyHeader = collectGroup(
  /\bx-api-key["']?[ \t]*:[ \t]*["'`]?(?!\[REDACTED|\$)([^\s"'`,;]+)/gi,
  "api_key",
  1,
  looksLikeSecret,
);

// JWTs always start with eyJ (base64url of `{"`), which keeps plain
// dotted strings out of scope.
const jwt = collect(
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}(?![A-Za-z0-9_-])/g,
  "jwt",
);

// Provider formats; tbk_ is the board's own key (TB-136, auth.ts). Two
// groups by what may precede the key:
// - github_pat_, xox…-: the body takes the prefix's own `_` or `-` but not
//   every character of the end check, so a run of "xoxb-" with a final `_`
//   failed at the end, restarted after every `-` and scanned to the end
//   again (64 KB: 1.5 s, Claude lens #283 B1). Such a key does not start
//   after `_` or `-` ("slack-xoxb-…" stays open: the price of linear time).
// - All others may follow `_` or `-` ("TOKEN_ghp_…", "id-glpat-…", lenses
//   #283): the body of sk-, sk-ant-, glpat- is the end check's class, so the
//   first start takes the whole run and never fails at its end; gh?_,
//   rk_live_, tbk_ have an alphanumeric body; AKIA, AIza a fixed length.
const apiKey = collect(
  /(?:(?<![A-Za-z0-9_-])(?:github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,})|(?<![A-Za-z0-9])(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,}|[sr]k_live_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|tbk_[A-Za-z0-9]{32,}))(?![A-Za-z0-9_-])/g,
  "api_key",
);

// A Telegram bot token, also inside an API URL (.../bot<token>/...), so only
// a digit may not precede it.
const telegramToken = collect(
  /(?<![0-9])[0-9]{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g,
  "api_key",
);

// A value given to a password name, in any case (JSON, YAML, code). The value
// stays on the same line; a reference ($VAR, ${VAR}, $(cmd)) is not a secret
// and stays readable.
//
// TB-199: the separator is `=`, `:`, `:=` (Go, Pascal) or `=>` (PHP, Ruby,
// Perl) in this and the three patterns below. Before, `:=` and `=>` gave `=`
// or `>` as the value, and the real value was left open. `==` and `===`
// with a space, a quote or the end after them compare and stay readable
// (`password === true`); glued to a value they are an assignment of a
// value that starts with `=`, masked as the base masked it
// (`DB_PASSWORD==<v>`, release #392 B1).
//
// A known cost (TB-201, Claude lens #392, 2): code after `=>` is masked as
// after `:` (`password => password.length`, `'password' => 'required'`).
// On `git ls-files` of tAIBE and HR_Helper-v2 (19 084 files): 0 such masks.
const passwordAssignment = collectGroup(
  /["']?(?:password|passwd|pwd)["']?[ \t]*(?::=|=>|=(?!=+(?:[\s"'`]|$))|:)[ \t]*["'`]?(?!\[REDACTED|\$)([^"'`\s]+)/gi,
  "password_assignment",
  1,
);

// TB-136: api_key, access_token, auth_token, private_key in any case, also
// as the end of a longer name (T_BOARDS_API_KEY, x-api-key: …), which is
// how the board's own keys without a prefix show up. The value ends at `,` or
// `;` (`KEY=<v>; cmd`, `{api_key: <v>, …}`): with them glued on, the filter
// dropped the key (Claude lens #283 B2). A password keeps them (it may hold
// them), so passwordAssignment above does not stop there.
const credentialAssignment = collectGroup(
  /["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?[ \t]*(?::=|=>|=(?!=+(?:[\s"'`]|$))|:)[ \t]*["'`]?(?!\[REDACTED|\$)([^"'`\s,;]+)/gi,
  "password_assignment",
  1,
  looksLikeSecret,
);

// Environment style, uppercase only: any NAME ending in API_KEY, TOKEN,
// SECRET or PASSWORD (GITHUB_TOKEN=, CLIENT_SECRET=). Prose like
// "the secret: ..." is lowercase and stays. The name starts where a run
// of [A-Z0-9_] starts, also after a lowercase prefix (foo_API_KEY,
// app_CLIENT_SECRET), and has at most 64 characters before the suffix: an
// open [A-Z0-9_]* that may start after every "_" made a run of "_" quadratic
// (64 000 characters: 2 s, TB-136 security lens). The value ends at `,` or
// `;`, as in credentialAssignment. A SECRET or PASSWORD name has its own
// pattern with the passphrase filter (TB-195): a name has one suffix, so a
// value is never found by both.
const secretAssignment = collectGroup(
  /(?<![A-Z0-9_])[A-Z0-9_]{0,64}(?:API_KEY|TOKEN)["']?[ \t]*(?::=|=>|=(?!=+(?:[\s"'`]|$))|:)[ \t]*["'`]?(?!\[REDACTED|\$)([^"'`\s,;]+)/g,
  "password_assignment",
  1,
  looksLikeSecret,
);
const passphraseAssignment = collectGroup(
  /(?<![A-Z0-9_])[A-Z0-9_]{0,64}(?:SECRET|PASSWORD)["']?[ \t]*(?::=|=>|=(?!=+(?:[\s"'`]|$))|:)[ \t]*["'`]?(?!\[REDACTED|\$)([^"'`\s,;]+)/g,
  "password_assignment",
  1,
  looksLikePassphrase,
);

// Long runs of the base64 alphabet that mix upper/lower/digit and carry
// high Shannon entropy are almost always encoded key material. Hex digests
// (git SHA, sha256) are single-case and UUIDs contain dashes, so neither
// reaches this detector.
const BASE64_BLOB_MIN_LENGTH = 64;
const BASE64_BLOB_MIN_ENTROPY = 4.5;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// TB-136, measured on this repo: a PascalCase name (routeTree.gen.ts:
// LayoutAuthenticated…Char123…Route), a data: URI, an SRI hash
// (integrity="sha384-…") and a URL path (/dashboard/workspace/<id>/…) pass
// the entropy bar but are not key material. Each character of IDENTIFIER has
// one way to match, so a long run never backtracks. The same rule is
// `is_base64_key` in infra/checks/secrets_scan.py.
const IDENTIFIER = /^[a-z]*(?:[A-Z][a-z]+|[A-Z](?![a-z])|[0-9])+$/;
const NOT_KEY_PREFIX = /(?:base64,|sha(?:256|384|512)-)$/;

function isBase64Key(text: string, start: number, token: string): boolean {
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) {
    return false;
  }
  if (shannonEntropy(token) < BASE64_BLOB_MIN_ENTROPY) return false;
  if (IDENTIFIER.test(token)) return false;
  if (NOT_KEY_PREFIX.test(text.slice(Math.max(0, start - 7), start))) {
    return false;
  }
  const pathWords = token
    .split("/")
    .filter((segment) => /^[a-z]{3,}$/.test(segment)).length;
  return pathWords < 2;
}

const base64Blob: Detector = (text) => {
  const hits: RedactHit[] = [];
  const pattern = new RegExp(
    `[A-Za-z0-9+/]{${BASE64_BLOB_MIN_LENGTH},}={0,2}`,
    "g",
  );
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    if (!isBase64Key(text, match.index, token)) continue;
    hits.push({
      kind: "base64_blob",
      start: match.index,
      end: match.index + token.length,
    });
  }
  return hits;
};

// Order matters: earlier detectors win overlaps (a PEM body is also a valid
// base64 blob, a JWT inside a Bearer header stays one hit).
const detectors: Detector[] = [
  pem,
  dbUrl,
  urlCredentials,
  bearer,
  jwt,
  apiKey,
  apiKeyHeader,
  telegramToken,
  passwordAssignment,
  credentialAssignment,
  secretAssignment,
  passphraseAssignment,
  base64Blob,
];

export function redact(text: string): { text: string; hits: RedactHit[] } {
  const accepted: RedactHit[] = [];
  for (const detector of detectors) {
    for (const hit of detector(text)) {
      accepted.push(hit);
    }
  }
  accepted.sort((a, b) => a.start - b.start || b.end - a.end);

  // A hit that starts inside the previous one and ends after it widens it:
  // dropped, its tail stayed in the text (A_SECRET=x(B_SECRET:C_PASSWORD:q;<v>,
  // Claude #375 B2; A_SECRET => password:x;passwd=><v>, TB-199).
  const hits: RedactHit[] = [];
  for (const hit of accepted) {
    const last = hits.at(-1);
    if (last && hit.start < last.end) {
      if (hit.end > last.end) hits[hits.length - 1] = { ...last, end: hit.end };
      continue;
    }
    hits.push(hit);
  }

  let result = "";
  let cursor = 0;
  for (const hit of hits) {
    result += text.slice(cursor, hit.start);
    result += `[REDACTED:${hit.kind}]`;
    cursor = hit.end;
  }
  result += text.slice(cursor);

  return { text: result, hits };
}
