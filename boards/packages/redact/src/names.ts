// TB-266: a secret or token name with a prefix or a suffix, in any case.
// The rules of index.ts see SECRET and TOKEN only in uppercase and only at
// the end of the name (CLIENT_SECRET=, GITHUB_TOKEN=), so a value under
// client_secret, SECRET_KEY, AWS_SECRET_ACCESS_KEY, github_token or
// refreshToken stayed open, in the CI scanner too (`NAMED` in
// infra/checks/secrets_scan.py is the pair of these rules). The name ends
// in a credential word that starts a word of the name:
// - after a letter or a digit and `_` or `-`, in any case (client_secret,
//   X-Client-Secret, github_token, DJANGO_SECRET_KEY);
// - as a hump after a letter or a digit (clientSecret, githubToken);
// - secret_key, secret_access_key, secret_key_base, secretKey, SecretKey
//   also with nothing before them (SECRET_KEY, AWS_SECRET_ACCESS_KEY).
// A bare `secret` or `token` is not taken: "the secret: ..." in prose stays
// readable (TB-195). The filter goes by the last word, as for the uppercase
// rules: a name that ends in `secret` may hold a passphrase
// (`looksLikePassphrase`), a name that ends in `key` or `token` holds a
// generated key (`looksLikeSecret`). So there are two patterns, one per
// filter. Each starts with the credential word and looks back over at most
// 2 characters before it, so the search stops only where the word is: the
// two take 24 and 44 ms on the 51 MB of tAIBE, one start-anchored uppercase
// rule of index.ts 164 ms. Redact of the three corpora below takes 7-9 %
// longer than on board-agents 4839e42b6.
//
// Such names are mostly code and UI text: on `git ls-files` of tAIBE,
// HR_Helper-v2 and hr_hf_helper the plain rules masked 183 values that are
// not secrets. A value is not taken here (in the scanner too) if it
// - starts with `!` (hasToken: !!row.token);
// - is a dotted name, digits and `?.` included (client_secret=
//   settings.GOOGLE_OAUTH2_CLIENT_SECRET, row?.tokenCipher);
// - is capitalized words, then `?`, `!` or `:` if any, in any context: a
//   locale label ("refreshToken": "Actualizar"), a type (secret_key:
//   KeyMask, Swift `String??`);
// - is a path (/run/secrets/postgres_password);
// - is in quotes that do not close before a space: a phrase
//   ("hideSecret": "Hide secret"), not a key.
// The price: a passphrase of capitalized words under such a name is open
// (client_secret=CorrectHorseBatteryStaple); CLIENT_SECRET= masks it.
import { looksLikePassphrase, looksLikeSecret } from "./value-shape.js";

// The word in any case. A class per letter, not flag `i`: the humps are
// case-sensitive and sit in the same pattern.
const anyCase = (word: string) =>
  word.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`);
const SECRET = anyCase("secret");
const TOKEN = anyCase("token");
const AFTER_WORD = "[A-Za-z0-9][_-]";

// `)` too: a value ends before it (SE-205, fn(client_secret=settings.KEY)).
const END = String.raw`(?:["'\x60\s,;})]|$)`;
const OPEN = String.raw`(?:"(?=[^"\s]*")|'(?=[^'\s]*')|\x60(?=[^\x60\s]*\x60)|(?!["'\x60]))`;
const CODE = String.raw`(?!!|[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+${END}|(?:[A-Z][a-z]+)+[?!:]*${END}|(?:\.{1,2}|~)?\/(?:[a-z0-9._-]+\/)+)`;
// The separator and the value, as in `secretAssignment` of index.ts.
const VALUE = String.raw`["']?[ \t]*(?::=|=>|=(?!=+(?:[\s"'\x60]|$))|:)[ \t]*${OPEN}(?!\[REDACTED|\$)${CODE}([^"'\x60\s,;]+)`;

// client_secret, X-Client-Secret; clientSecret, ClientSecret.
const SECRET_NAME = [
  `${SECRET}(?<=${AFTER_WORD}${SECRET})`,
  "Secret(?<=[A-Za-z0-9]Secret)",
].join("|");
// secret_key, DJANGO_SECRET_KEY, aws_secret_access_key, secret_key_base;
// secretKey, SecretKey, clientSecretKey; github_token; githubToken.
const KEY_NAME = [
  `${SECRET}(?:(?<=${AFTER_WORD}${SECRET})|(?<![A-Za-z0-9_-]${SECRET}))[_-](?:${anyCase("access")}[_-])?${anyCase("key")}(?:[_-]${anyCase("base")})?`,
  "(?:Secret(?<=[A-Za-z0-9]Secret)|[Ss]ecret(?<![A-Za-z0-9_-][Ss]ecret))(?:Access)?Key(?:Base)?",
  `${TOKEN}(?<=${AFTER_WORD}${TOKEN})`,
  "Token(?<=[A-Za-z0-9]Token)",
].join("|");

export type NamePattern = {
  pattern: RegExp;
  accept: (value: string, next: string) => boolean;
};

export const NAME_PATTERNS: NamePattern[] = [
  {
    pattern: new RegExp(`(?:${SECRET_NAME})${VALUE}`, "g"),
    accept: looksLikePassphrase,
  },
  {
    pattern: new RegExp(`(?:${KEY_NAME})${VALUE}`, "g"),
    accept: looksLikeSecret,
  },
];
