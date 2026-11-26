import { PASSKEY_ERRORS, PASSKEY_NAME_MAX } from "@kaneo/permissions";
import { APIError } from "better-auth/api";

// The routes of `@better-auth/passkey` that write a key name the person typed.
export const NAMED_PASSKEY_ROUTES = new Set([
  "/passkey/update-passkey",
  "/passkey/verify-registration",
]);

/**
 * TB-260: the plugin's schemas trim the name but take any length. A name that
 * is not a string is left to the plugin's schema; it answers 400 itself.
 */
export function assertPasskeyNameFits(body: unknown): void {
  const name = (body as { name?: unknown } | null | undefined)?.name;
  if (typeof name !== "string" || name.trim().length <= PASSKEY_NAME_MAX)
    return;
  throw new APIError("BAD_REQUEST", {
    code: PASSKEY_ERRORS.nameTooLong,
    message: `A key name is at most ${PASSKEY_NAME_MAX} characters.`,
  });
}
