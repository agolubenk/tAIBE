import { markSessionFresh } from "./store";

/**
 * TB-31 R-5: paths where a person has just proved who they are. `ctx.path`
 * is the route template, so the OAuth callbacks match by prefix.
 * `/sign-up/*` is out on purpose: a new user confirms the password for the
 * first protected action. `/device/token` and impersonation are out too.
 */
const INTERACTIVE_EXACT = new Set([
  "/sign-in/email",
  "/sign-in/username",
  "/sign-in/email-otp",
  "/magic-link/verify",
  "/passkey/verify-authentication",
]);
const INTERACTIVE_PREFIX = ["/callback/", "/oauth2/callback/"];

export function isInteractiveSignIn(path: string | undefined): boolean {
  if (!path) return false;
  return (
    INTERACTIVE_EXACT.has(path) ||
    INTERACTIVE_PREFIX.some((prefix) => path.startsWith(prefix))
  );
}

type CreatedSession = {
  id: string;
  userId: string;
  impersonatedBy?: string | null;
};

/**
 * `databaseHooks.session.create.after`: marks a session fresh only when an
 * interactive sign-in made it. No request context means not interactive.
 * Never throws: a failed mark costs one confirmation, a thrown error would
 * cost the sign-in.
 */
export async function markInteractiveSession(
  session: CreatedSession,
  ctx: { path?: string } | null | undefined,
): Promise<void> {
  if (!ctx || session.impersonatedBy || !isInteractiveSignIn(ctx.path)) return;
  try {
    await markSessionFresh(session.id, session.userId);
  } catch (error) {
    console.error(
      "[reauth] could not mark a new session fresh",
      error instanceof Error ? error.message : error,
    );
  }
}
