import { REAUTH_ERRORS, type ReauthErrorBody } from "@kaneo/permissions";
import { APIError, type getSessionFromCtx } from "better-auth/api";
import { adminEmailChanges } from "../user/controllers/clear-email-verification-on-admin-change";
import { setsLogin } from "../username/username-login";
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
 * Slice B: an admin setting a user's password or signing in as a user takes
 * the account like an email change does (owner, taibe-d-tb31-scope-1811 = A).
 * `/device/approve` gives a device a session that issues agent keys without a
 * confirmation (owner, taibe-d-tb31-agent-key-1811 = A): the approval is the
 * confirmation. `/update-user` that sets the login (R-1) is guarded: the login
 * signs in like the email does. The passkey routes and the email change follow.
 */
const ALWAYS_GUARDED = new Set([
  "/api-key/create",
  "/delete-user",
  "/list-sessions",
  "/unlink-account",
  "/admin/set-user-password",
  "/admin/impersonate-user",
  "/device/approve",
]);

/** What a route needs: always a fresh session, only for an email change, or nothing. */
function guardKind(ctx: GuardContext): "always" | "admin-email" | null {
  if (ALWAYS_GUARDED.has(ctx.path)) return "always";
  if (ctx.path === "/update-user") return setsLogin(ctx.body) ? "always" : null;
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

export const NOT_FRESH_MESSAGE = "Confirm it's you to continue.";

export type NotFreshBody = Omit<ReauthErrorBody, "message">;

export function notFreshError(body: NotFreshBody) {
  return new APIError("FORBIDDEN", { message: NOT_FRESH_MESSAGE, ...body });
}

/**
 * The SESSION_NOT_FRESH body for a session that may not act now, or null.
 * An impersonated session never may: the person behind it is the admin.
 * `alsoPasses` lets a route accept another mark (the device flow's).
 */
export async function staleSessionRefusal(
  session: GuardSession["session"],
  userId: string,
  alsoPasses?: (sessionId: string, userId: string) => Promise<boolean>,
): Promise<NotFreshBody | null> {
  // `impersonatedBy` comes from the admin plugin's session fields.
  if (session.impersonatedBy) {
    return {
      code: REAUTH_ERRORS.sessionNotFresh,
      methods: [],
      impersonated: true,
    };
  }
  if (alsoPasses && (await alsoPasses(session.id, userId))) return null;
  if (await isSessionFresh(session.id, userId)) return null;
  return {
    code: REAUTH_ERRORS.sessionNotFresh,
    methods: await availableMethods(userId, false),
  };
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
  const refused = await staleSessionRefusal(session, user.id);
  if (refused) throw notFreshError(refused);
}
