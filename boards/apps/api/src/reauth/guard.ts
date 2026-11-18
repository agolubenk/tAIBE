import { REAUTH_ERRORS, type ReauthErrorBody } from "@kaneo/permissions";
import { APIError, type getSessionFromCtx } from "better-auth/api";
import { adminEmailChanges } from "../user/controllers/clear-email-verification-on-admin-change";
import { availableMethods } from "./methods";
import { isSessionFresh } from "./store";

type GuardContext = Parameters<typeof getSessionFromCtx>[0];

/** The session a guarded endpoint will act for. */
export type GuardSession = {
  session: { id: string; impersonatedBy?: string | null };
  user: { id: string };
};

/**
 * Resolves a request's session through every before hook (auth.ts passes
 * `auth.api.getSession`). The guard runs in the user hook, before the bearer
 * plugin turns `Authorization: Bearer` into the session cookie, and that
 * cookie wins over the browser's (better-auth `dispatch.mjs`, runBeforeHooks).
 * So the guard must not read the cookie itself: it would check another
 * session, or none, and let the endpoint act for the Bearer one.
 */
export type SessionResolver = (
  headers: Headers,
) => Promise<GuardSession | null>;

/**
 * TB-31 R-5, slice A. `/list-sessions` and `/unlink-account` are here
 * because `session.freshAge` is 0: better-auth no longer checks them itself.
 * Slice B adds the passkey routes, the username and the email change.
 */
const ALWAYS_GUARDED = new Set([
  "/api-key/create",
  "/delete-user",
  "/list-sessions",
  "/unlink-account",
]);

async function needsFreshSession(ctx: GuardContext): Promise<boolean> {
  if (ALWAYS_GUARDED.has(ctx.path)) return true;
  if (ctx.path !== "/admin/update-user") return false;
  const body = ctx.body as { userId?: unknown; data?: unknown } | undefined;
  const data = body?.data;
  if (!data || typeof data !== "object" || !Object.hasOwn(data, "email"))
    return false;
  const userId = body?.userId;
  const email = (data as { email?: unknown }).email;
  // better-auth coerces userId (`z.coerce.string()`): ["id"] acts on "id".
  // Anything but two strings is guarded, not guessed.
  if (typeof userId !== "string" || typeof email !== "string") return true;
  return adminEmailChanges(userId, email);
}

export function notFreshError(body: Omit<ReauthErrorBody, "message">) {
  return new APIError("FORBIDDEN", {
    message: "Confirm it's you to continue.",
    ...body,
  });
}

/**
 * Throws 403 SESSION_NOT_FRESH on a guarded route without a live mark.
 * Server-side `auth.api.*` calls carry no request and pass: the server
 * itself (agent keys, tests) is not a person who must confirm anything.
 * No session — the endpoint resolves the same way and answers 401 itself.
 * A failed lookup throws: the guard does not pass a request it could not check.
 */
export async function assertFreshSession(
  ctx: GuardContext,
  resolveSession: SessionResolver,
): Promise<void> {
  if (!ctx.request) return;
  if (!(await needsFreshSession(ctx))) return;
  const found = await resolveSession(ctx.headers ?? ctx.request.headers);
  if (!found?.session) return;
  const { session, user } = found;
  // `impersonatedBy` comes from the admin plugin's session fields.
  if ((session as { impersonatedBy?: string | null }).impersonatedBy) {
    throw notFreshError({
      code: REAUTH_ERRORS.sessionNotFresh,
      methods: [],
      impersonated: true,
    });
  }
  if (await isSessionFresh(session.id, user.id)) return;
  throw notFreshError({
    code: REAUTH_ERRORS.sessionNotFresh,
    methods: await availableMethods(user.id, false),
  });
}
