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

// Replaces only group 1 of each match, keeping the surrounding context
// (header name, assignment key, quotes) readable.
function collectGroup(
  pattern: RegExp,
  kind: SecretKind,
  group: number,
  accept: (value: string) => boolean = () => true,
): Detector {
  return (text) => {
    const hits: RedactHit[] = [];
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[group];
      if (value === undefined || !accept(value)) continue;
      const start = match.index + match[0].indexOf(value);
      hits.push({ kind, start, end: start + value.length });
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

// The password part has at most 256 characters: unbounded, it ran to the end
// of the text from every scheme of a "postgres://a:" run.
const dbUrl = collect(
  /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s"'`/]*:[^\s@"'`]{1,256}@[^\s"'`]+/gi,
  "db_url",
);

// TB-136: a value given to a credential name in code is mostly code
// (options.apiKey, z.string(), apiKey) or a placeholder
// (your_secure_password), not a secret. Measured on this repo: without this
// filter 95% of the new assignment hits were such code. A key has 8+
// printable ASCII characters, no code punctuation, and is not a dotted name,
// words joined by _ or -, or a short camelCase name. The same filter is
// `looks_like_secret` in infra/checks/secrets_scan.py.
export function looksLikeSecret(value: string): boolean {
  if (value.length < 8 || !/^[\x21-\x7e]+$/.test(value)) return false;
  if (/[(){}[\];,<>\\]/.test(value)) return false;
  if (/^[A-Za-z_$]+(?:\.[A-Za-z_$]+)+$/.test(value)) return false;
  if (/^[A-Za-z]+(?:[_-][A-Za-z]+)+$/.test(value)) return false;
  return !(value.length < 32 && /^[a-z]+(?:[A-Z][a-z0-9]*)*$/.test(value));
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

const bearer = collectGroup(
  /Authorization\s*:\s*Bearer\s+(?!\[REDACTED)([^\s"']+)/gi,
  "bearer",
  1,
);

// TB-136: the header of the board's own API keys, like `bearer`. Keys issued
// before the tbk_ prefix are 64 letters with no format of their own. In code
// the header mostly carries a variable ("x-api-key": apiKey), hence the filter.
const apiKeyHeader = collectGroup(
  /\bx-api-key["']?\s*:\s*["'`]?(?!\[REDACTED|\$)([^\s"'`,;]+)/gi,
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

// Provider formats; tbk_ is the board's own key (TB-136, auth.ts).
const apiKey = collect(
  /(?<![A-Za-z0-9])(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|[sr]k_live_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|tbk_[A-Za-z0-9]{32,})(?![A-Za-z0-9_-])/g,
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
// how the board's own keys without a prefix show up.
const credentialAssignment = collectGroup(
  /["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?[ \t]*[:=][ \t]*["'`]?(?!\[REDACTED|\$)([^"'`\s]+)/gi,
  "password_assignment",
  1,
  looksLikeSecret,
);

// Environment style, uppercase only: any NAME ending in API_KEY, TOKEN,
// SECRET or PASSWORD (GITHUB_TOKEN=, CLIENT_SECRET=). Prose like
// "the secret: ..." is lowercase and stays. The name starts after a
// non-name character or after "<lowercase>_" (foo_GITHUB_TOKEN) and has at
// most 64 characters before the suffix: an
// open [A-Z0-9_]* that may start after every "_" made a run of "_" quadratic
// (64 000 characters: 2 s, TB-136 security lens).
const secretAssignment = collectGroup(
  /(?:(?<![A-Za-z0-9_])|(?<=[a-z]_))[A-Z0-9_]{0,64}(?:API_KEY|TOKEN|SECRET|PASSWORD)["']?[ \t]*[:=][ \t]*["'`]?(?!\[REDACTED|\$)([^"'`\s]+)/g,
  "password_assignment",
  1,
  looksLikeSecret,
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
