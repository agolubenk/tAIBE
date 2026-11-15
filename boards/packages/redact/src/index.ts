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

type Detector = (text: string) => RedactHit[];

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

// A character that drops every value holding it in `secretShaped`: code
// punctuation or a character outside printable ASCII.
const DROPS_VALUE = /[(){}[\];,<>\\]|[^\x21-\x7e]/;

function lastDropping(value: string): number {
  for (let i = value.length - 1; i >= 0; i--) {
    if (DROPS_VALUE.test(value.charAt(i))) return i;
  }
  return -1;
}

const NAME_CHAR = /[A-Za-z0-9_-]/;

// The start of the run of name characters that ends the value (a final `:`
// or `=` aside), or -1.
function trailingName(value: string): number {
  const last = value.charAt(value.length - 1);
  const end = last === ":" || last === "=" ? value.length - 1 : value.length;
  let start = end;
  while (start > 0 && NAME_CHAR.test(value.charAt(start - 1))) start -= 1;
  return start < end ? start : -1;
}

// Replaces only group 1 of each match, keeping the surrounding context
// (header name, assignment key, quotes) readable. `accept` also gets the
// character after the value ("" at the end of the text).
//
// TB-198: after a value the search goes on where another name may start:
// - in a rejected value, after its last DROPS_VALUE character
//   (B_SECRET="x(=C_SECRET=<v>). A value with `=` or `:` in it is not a
//   name of any shape, so a filter rejects it only for its length or for
//   such a character, and then every value that holds it too;
// - otherwise at the run of name characters that ends the value: that name
//   has its separator after the value, past a space or a quote
//   (A_TOKEN=x.B_TOKEN = <v>, A_SECRET=fooB_SECRET: <v>, Control #375).
// An inner match can end after the outer value: its separator crosses the
// space or the quote that ends the outer value
// (A_TOKEN=x(B_TOKEN = C_TOKEN = <v>). Then the next search starts at the
// end of the outer value (`limit`) at the latest, as without the rewind.
// Each search starts after the start of the last match.
function collectGroup(
  pattern: RegExp,
  kind: SecretKind,
  group: number,
  accept: (value: string, next: string) => boolean = () => true,
): Detector {
  return (text) => {
    const hits: RedactHit[] = [];
    let limit = -1;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const value = match[group];
      if (value === undefined) continue;
      const start = match.index + match[0].indexOf(value);
      const accepted = accept(value, text.charAt(start + value.length));
      if (accepted) hits.push({ kind, start, end: start + value.length });
      const dropping = accepted ? -1 : lastDropping(value);
      if (dropping >= 0) limit = Math.max(limit, pattern.lastIndex);
      const resume = dropping >= 0 ? dropping + 1 : trailingName(value);
      if (resume >= 0) {
        pattern.lastIndex = Math.max(match.index + 1, start + resume);
      }
      if (match.index < limit && pattern.lastIndex > limit) {
        pattern.lastIndex = limit;
      }
    }
    return hits;
  };
}

// PEM blocks end in "KEY-----", PGP key blocks in "KEY BLOCK-----".
// A BEGIN line up to the nearest END line. Not one lazy regex: from every
// BEGIN without an END it scans to the end of the text, so 256 KB of BEGIN
// lines took 1.3 s (TB-136 security lens). If a BEGIN has no END after it, a
// later BEGIN has none either, so the scan stops there.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z0-9 ]*KEY(?: BLOCK)?-----/g;

const pem: Detector = (text) => {
  const hits: RedactHit[] = [];
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin; begin = PEM_BEGIN.exec(text)) {
    PEM_END.lastIndex = PEM_BEGIN.lastIndex;
    if (!PEM_END.exec(text)) break;
    hits.push({ kind: "pem", start: begin.index, end: PEM_END.lastIndex });
    PEM_BEGIN.lastIndex = PEM_END.lastIndex;
  }
  return hits;
};

// The user and the password have at most 256 characters each: unbounded,
// they ran to the end of the text from every scheme of a "postgres://a:" run.
const dbUrl = collect(
  /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s"'`/:@]{0,256}:[^\s@"'`]{1,256}@[^\s"'`]+/gi,
  "db_url",
);

// TB-136: a value given to a credential name in code is mostly code
// (options.apiKey, z.string(), apiKey) or a placeholder
// (your_secure_password), not a secret. Measured on this repo: without this
// filter 95% of the new assignment hits were such code. A key has 8+
// printable ASCII characters, no code punctuation, and is not a dotted name,
// words joined by _ or -, or a short camelCase name. `looks_like_secret` in
// infra/checks/secrets_scan.py has the same rules except the type name
// below and the passphrase rule (TB-195): the scanner drops a type name in
// any context (TB-193) and lowercase words after any name.
//
// A type name is capitalized words with no digit. Since the value ends at `,`
// and `;` (#283 B2), the comma no longer drops `apiKey: ApiKeyUsageRow,`.
// TB-193: such a value is a type only if `,`, `;` or `)` comes right after
// it (`next`), as in a parameter list or a type literal (today the value
// patterns glue `)` to the value, and the punctuation rule drops it; the set
// keeps it so the rule does not depend on a pattern). Elsewhere it may be
// a passphrase (CLIENT_SECRET=<capitalized words> at the end of a line) and
// is masked. The price: a type with no punctuation after it is masked too
// (`apiKey: ApiKeyItem | null`, a type line with no `;`). The end of a line
// is not a type context: an .env value ends there.
const TYPE_NAME = /^(?:[A-Z][a-z]+)+$/;
const TYPE_CONTEXT = new Set([",", ";", ")"]);
const CAMEL_NAME = /^[a-z]+(?:[A-Z][a-z0-9]*)*$/;
// TB-195: a camelCase name with at least one capital inside (jwtSecret).
const HUMPED_NAME = /^[a-z]+(?:[A-Z][a-z0-9]*)+$/;

function secretShaped(value: string, next: string, name: RegExp): boolean {
  if (value.length < 8 || DROPS_VALUE.test(value)) return false;
  if (/^[A-Za-z_$]+(?:\.[A-Za-z_$]+)+$/.test(value)) return false;
  if (/^[A-Za-z]+(?:[_-][A-Za-z]+)+$/.test(value)) return false;
  if (value.length >= 32) return true;
  if (name.test(value)) return false;
  return !(TYPE_NAME.test(value) && TYPE_CONTEXT.has(next));
}

export function looksLikeSecret(value: string, next = ""): boolean {
  return secretShaped(value, next, CAMEL_NAME);
}

// TB-195: a SECRET or PASSWORD name may hold a passphrase of lowercase words
// joined together (CLIENT_SECRET=<words> at the end of an .env line), and
// the camelCase rule read it as a variable name. For these names only a
// name with a capital inside (jwtSecret) and the literal `undefined` stay
// open. Measured on `git ls-files` of tAIBE and HR_Helper-v2: no new mask of
// a SECRET name; a PASSWORD name was masked already by passwordAssignment.
export function looksLikePassphrase(value: string, next = ""): boolean {
  return value !== "undefined" && secretShaped(value, next, HUMPED_NAME);
}

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
const bearer = collectGroup(
  /Authorization["']?\s*:\s*["']?Bearer\s+(?!\[REDACTED)([^\s"']+)/gi,
  "bearer",
  1,
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
const passwordAssignment = collectGroup(
  /["']?(?:password|passwd|pwd)["']?[ \t]*[:=][ \t]*["'`]?(?!\[REDACTED|\$)([^"'`\s]+)/gi,
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
  /["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?[ \t]*[:=][ \t]*["'`]?(?!\[REDACTED|\$)([^"'`\s,;]+)/gi,
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
  /(?<![A-Z0-9_])[A-Z0-9_]{0,64}(?:API_KEY|TOKEN)["']?[ \t]*[:=][ \t]*["'`]?(?!\[REDACTED|\$)([^"'`\s,;]+)/g,
  "password_assignment",
  1,
  looksLikeSecret,
);
const passphraseAssignment = collectGroup(
  /(?<![A-Z0-9_])[A-Z0-9_]{0,64}(?:SECRET|PASSWORD)["']?[ \t]*[:=][ \t]*["'`]?(?!\[REDACTED|\$)([^"'`\s,;]+)/g,
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

  const hits: RedactHit[] = [];
  let cursor = 0;
  for (const hit of accepted) {
    if (hit.start < cursor) continue;
    hits.push(hit);
    cursor = hit.end;
  }

  let result = "";
  cursor = 0;
  for (const hit of hits) {
    result += text.slice(cursor, hit.start);
    result += `[REDACTED:${hit.kind}]`;
    cursor = hit.end;
  }
  result += text.slice(cursor);

  return { text: result, hits };
}
