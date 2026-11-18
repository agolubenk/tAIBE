import { REAUTH_ERRORS, type ReauthErrorBody } from "@kaneo/permissions";
import { APIError, getSessionFromCtx } from "better-auth/api";
import { adminEmailChanges } from "../user/controllers/clear-email-verification-on-admin-change";
import { availableMethods } from "./methods";
import { isSessionFresh } from "./store";

type GuardContext = Parameters<typeof getSessionFromCtx>[0];

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
  return adminEmailChanges(body?.userId, (data as { email?: unknown }).email);
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
 * No session — the endpoint answers 401 itself.
 */
export async function assertFreshSession(ctx: GuardContext): Promise<void> {
  if (!ctx.request) return;
  if (!(await needsFreshSession(ctx))) return;
  const found = await getSessionFromCtx(ctx, {
    disableCookieCache: true,
    disableRefresh: true,
  }).catch(() => null);
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
