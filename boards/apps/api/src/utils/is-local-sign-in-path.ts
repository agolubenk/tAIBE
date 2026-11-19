// TB-31 R-1: the login signs in like the email does, so DISABLE_LOGIN_FORM
// closes `/sign-in/username` too.
const localSignInPaths = new Set([
  "/sign-in/email",
  "/sign-in/username",
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
