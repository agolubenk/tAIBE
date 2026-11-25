// TB-31 R-1, login: one rule for the API (better-auth `username` plugin) and
// the web form. Spec: docs/impl/impl-tb119-profile-login.md, R-1.

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

// Latin letters and digits only: no dots, no underscores, no lookalikes.
const USERNAME_PATTERN = /^[A-Za-z0-9]+$/;

// Names that look like the service or its staff. Compared in lower case.
// `t-boards` cannot pass the pattern; it stays so the list is the spec's list.
export const RESERVED_USERNAMES: readonly string[] = [
  "admin",
  "administrator",
  "root",
  "system",
  "support",
  "help",
  "agent",
  "api",
  "bot",
  "null",
  "t-boards",
  "tboards",
  "kaneo",
  "owner",
  "security",
];

export type UsernameProblem = "tooShort" | "tooLong" | "invalid" | "reserved";

/** Why a login cannot be used, or null. Taken logins are the server's check. */
export function usernameProblem(value: string): UsernameProblem | null {
  if (value.length < USERNAME_MIN_LENGTH) return "tooShort";
  if (value.length > USERNAME_MAX_LENGTH) return "tooLong";
  if (!USERNAME_PATTERN.test(value)) return "invalid";
  if (RESERVED_USERNAMES.includes(value.toLowerCase())) return "reserved";
  return null;
}

export function isAllowedUsername(value: string): boolean {
  return usernameProblem(value) === null;
}

/** The sign-in form sends a value with `@` to the email route. */
export function isEmailLogin(value: string): boolean {
  return value.includes("@");
}
