// The shape of a value: what is code and what may be a secret. Moved from
// index.ts as it was (TB-201): with the code-name rule it had 508 lines.

// A character that drops every value holding it in `secretShaped`: code
// punctuation or a character outside printable ASCII.
export const DROPS_VALUE = /[(){}[\];,<>\\]|[^\x21-\x7e]/;

// TB-136: a value given to a credential name in code is mostly code
// (options.apiKey, z.string(), apiKey) or a placeholder
// (your_secure_password), not a secret. Measured on this repo: without this
// filter 95% of the new assignment hits were such code. A key has 8+
// printable ASCII characters, no code punctuation, and is not a dotted name,
// words joined by _ or -, or a short camelCase name. The CI scanner
// (infra/checks/secrets_scan.py) is a gate and this is a mask, so they
// differ on purpose:
// - `looks_like_secret` (key and token names) has these rules, but drops a
//   type name in any context, not only before `,`, `;` or `)` (TB-193):
//   with the context rule a locale label and a type line became CI errors;
// - `looks_like_password` (password and secret names) is
//   `looksLikePassphrase` below (TB-195; the type context rule since
//   TB-200). A letters-only value of 20+ characters needs entropy 3.0,
//   others 3.5;
// - both also drop Laravel validation rules
//   ('password' => 'required|string|min:8', TB-200); here they are masked.
//
// A type name is capitalized words with no digit. Since the value ends at `,`
// and `;` (#283 B2), the comma no longer drops `apiKey: ApiKeyUsageRow,`.
// TB-193: such a value is a type only if `,`, `;` or `)` comes right after
// it (`next`), as in a parameter list or a type literal (today the value
// patterns glue `)` to the value, and the punctuation rule drops it; the set
// keeps it so the rule does not depend on a pattern). Elsewhere it may be
// a passphrase (CLIENT_SECRET=<capitalized words> at the end of a line) and
// is masked. TB-213: redact() gives `next` only in an annotation (a bare `:`
// before the value, `annotation` in index.ts); after `=`, `:=`, `=>` or a
// quote `next` is "" and the words are masked (CLIENT_SECRET=<words>;). The
// price: a type with no punctuation after it is masked too
// (`apiKey: ApiKeyItem | null`, a type line with no `;`). The end of a line
// is not a type context: an .env value ends there.
const TYPE_NAME = /^(?:[A-Z][a-z]+)+$/;
const TYPE_CONTEXT = new Set([",", ";", ")"]);
const CAMEL_NAME = /^[a-z]+(?:[A-Z][a-z0-9]*)*$/;
// TB-195: a camelCase name with at least one capital inside (jwtSecret).
const HUMPED_NAME = /^[a-z]+(?:[A-Z][a-z0-9]*)+$/;
const DOTTED_NAME = /^[A-Za-z_$]+(?:\.[A-Za-z_$]+)+$/;

// A name of code: a dotted name (options.api_key) or a camelCase name with a
// capital inside (githubToken).
export function codeName(value: string): boolean {
  return DOTTED_NAME.test(value) || HUMPED_NAME.test(value);
}

function secretShaped(value: string, next: string, name: RegExp): boolean {
  if (value.length < 8 || DROPS_VALUE.test(value)) return false;
  if (DOTTED_NAME.test(value)) return false;
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
