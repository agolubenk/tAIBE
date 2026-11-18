import { REAUTH_ERRORS, type ReauthErrorBody } from "@kaneo/permissions";
import { APIError, type getSessionFromCtx } from "better-auth/api";
import { adminEmailChanges } from "../user/controllers/clear-email-verification-on-admin-change";
import { canUpdateUsers } from "./admin-role";
import { availableMethods } from "./methods";
import { isSessionFresh } from "./store";

type GuardContext = Parameters<typeof getSessionFromCtx>[0];

/** The session a guarded endpoint will act for. */
export type GuardSession = {
  session: { id: string; impersonatedBy?: string | null };
  user: { id: string; role?: string | null };
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

/** What a route needs: always a fresh session, only for an email change, or nothing. */
function guardKind(ctx: GuardContext): "always" | "admin-email" | null {
  if (ALWAYS_GUARDED.has(ctx.path)) return "always";
  if (ctx.path !== "/admin/update-user") return null;
  const data = (ctx.body as { data?: unknown } | undefined)?.data;
  if (!data || typeof data !== "object" || !Object.hasOwn(data, "email"))
    return null;
  return "admin-email";
}

/**
 * `/admin/update-user` with an email needs a fresh session when the email
 * changes. The target is read only for a role that may update users (release
 * N14): for any other caller, the guard's 403 against the plugin's 403 would
 * tell whether an email is that user's. Such a caller is guarded unread.
 */
async function adminEmailNeedsFresh(
  ctx: GuardContext,
  role: string | null | undefined,
): Promise<boolean> {
  const body = ctx.body as { userId?: unknown; data: { email?: unknown } };
  const userId = body.userId;
  const email = body.data.email;
  // better-auth coerces userId (`z.coerce.string()`): ["id"] acts on "id".
  // Anything but two strings is guarded, not guessed.
  if (typeof userId !== "string" || typeof email !== "string") return true;
  if (!canUpdateUsers(role)) return true;
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
  const kind = guardKind(ctx);
  if (!kind) return;
  const found = await resolveSession(ctx.headers ?? ctx.request.headers);
  if (!found?.session) return;
  const { session, user } = found;
  if (kind === "admin-email" && !(await adminEmailNeedsFresh(ctx, user.role)))
    return;
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
