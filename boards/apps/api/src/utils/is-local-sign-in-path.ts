// TB-31: the login (R-1) and the passkey (R-6) are local sign-in too. With
// DISABLE_LOGIN_FORM a key neither signs in nor confirms (reauth/methods.ts).
const localSignInPaths = new Set([
  "/sign-in/email",
  "/sign-in/username",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
  "/request-password-reset",
  "/reset-password",
  "/sign-in/magic-link",
  "/magic-link/verify",
  "/sign-in/email-otp",
]);

export function isLocalSignInPath(path: string) {
  return (
    localSignInPaths.has(path) ||
    path.startsWith("/email-otp/") ||
    path.startsWith("/reset-password/")
  );
}

export function isLoginFormDisabled(
  env: Record<string, string | undefined> = process.env,
) {
  return env.DISABLE_LOGIN_FORM === "true";
}
