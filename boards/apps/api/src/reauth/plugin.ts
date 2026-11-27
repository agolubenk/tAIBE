import { reauthCodeSubject, sendReauthCodeEmail } from "@kaneo/email";
import {
  REAUTH_CODE_LENGTH,
  REAUTH_CODE_TTL_SECONDS,
  REAUTH_ERRORS,
  REAUTH_ROUTES,
  type ReauthError,
  type ReauthMethod,
} from "@kaneo/permissions";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import { eq } from "drizzle-orm";
import * as z from "zod";
import db, { schema } from "../database";
import { getEmailRequestContext } from "../utils/email-request-context";
import { availableMethods, passwordHash } from "./methods";
import {
  checkCode,
  dropCode,
  issueCode,
  markSessionFresh,
  recordFailure,
  reserveTry,
  resetFailures,
} from "./store";

type Status = ConstructorParameters<typeof APIError>[0];

const MESSAGES: Partial<Record<ReauthError, string>> = {
  [REAUTH_ERRORS.invalidPassword]: "The password is not correct.",
  [REAUTH_ERRORS.invalidCode]: "The code is not correct.",
  [REAUTH_ERRORS.codeExpired]: "The code is no longer valid. Send a new code.",
  [REAUTH_ERRORS.methodUnavailable]: "This way to confirm is not available.",
  [REAUTH_ERRORS.impersonated]:
    "Protected actions are not available under another user's name.",
  [REAUTH_ERRORS.emailDeliveryFailed]:
    "The code could not be sent. Try again later.",
};

function reauthError(
  status: Status,
  code: ReauthError,
  methods?: ReauthMethod[],
) {
  return new APIError(status, {
    code,
    message: MESSAGES[code] ?? code,
    ...(methods ? { methods } : {}),
  });
}

type Session = {
  session: { id: string; impersonatedBy?: string | null };
  user: { id: string; email: string };
};

/** Under impersonation no method is offered and every route refuses. */
function ownSession(ctx: { context: { session: unknown } }): Session {
  const found = ctx.context.session as Session;
  if (found.session.impersonatedBy) {
    throw reauthError("FORBIDDEN", REAUTH_ERRORS.impersonated);
  }
  return found;
}

async function requireMethod(userId: string, method: ReauthMethod) {
  const methods = await availableMethods(userId, false);
  if (!methods.includes(method)) {
    throw reauthError("BAD_REQUEST", REAUTH_ERRORS.methodUnavailable, methods);
  }
}

/** A refusal that carries the methods left. */
async function refused(userId: string, code: ReauthError) {
  return reauthError(
    "BAD_REQUEST",
    code,
    await availableMethods(userId, false),
  );
}

/** A failed confirmation counts; the reply carries the methods left. */
async function failed(userId: string, code: ReauthError) {
  await recordFailure(userId);
  return refused(userId, code);
}

async function confirmed(sessionId: string, userId: string) {
  await markSessionFresh(sessionId, userId);
  await resetFailures(userId);
  return { status: true as const };
}

async function userLocale(userId: string) {
  const [row] = await db
    .select({ locale: schema.userTable.locale })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .limit(1);
  return row?.locale ?? null;
}

const CODE_RE = new RegExp(`^\\d{${REAUTH_CODE_LENGTH}}$`);

/**
 * TB-31 R-5: confirm "it's you" in the current session. Success marks this
 * session fresh for 5 minutes; no new session, no new cookie.
 * Limits per IP are in utils/auth-rate-limit.ts; the per-user failure
 * counter is in store.ts.
 */
export const reauthPlugin = () =>
  ({
    id: "tb-reauth",
    endpoints: {
      tbReauthPassword: createAuthEndpoint(
        REAUTH_ROUTES.password,
        {
          method: "POST",
          body: z.object({ password: z.string().min(1).max(1024) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const { session, user } = ownSession(ctx);
          await requireMethod(user.id, "password");
          // TB-245: the try is counted before the check, so a burst of
          // parallel wrong passwords gets at most the limit of checks.
          if (!(await reserveTry(user.id))) {
            throw await refused(user.id, REAUTH_ERRORS.methodUnavailable);
          }
          const hash = await passwordHash(user.id);
          const ok =
            hash !== null &&
            (await ctx.context.password.verify({
              hash,
              password: ctx.body.password,
            }));
          // Counted already by reserveTry.
          if (!ok) throw await refused(user.id, REAUTH_ERRORS.invalidPassword);
          return ctx.json(await confirmed(session.id, user.id));
        },
      ),
      tbReauthSendCode: createAuthEndpoint(
        REAUTH_ROUTES.sendCode,
        { method: "POST", body: z.object({}), use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ownSession(ctx);
          await requireMethod(user.id, "emailCode");
          const code = await issueCode(session.id);
          const locale = await userLocale(user.id);
          let sent = false;
          try {
            const result = await sendReauthCodeEmail(
              user.email,
              reauthCodeSubject(code, locale),
              {
                code,
                minutes: REAUTH_CODE_TTL_SECONDS / 60,
                locale,
                ...getEmailRequestContext(ctx.request?.headers ?? ctx.headers),
              },
            );
            sent = result.success;
          } catch (error) {
            console.error(
              "[reauth] could not send the code:",
              error instanceof Error ? error.message : error,
            );
            sent = false;
          }
          if (!sent) {
            await dropCode(session.id, code);
            throw reauthError("BAD_GATEWAY", REAUTH_ERRORS.emailDeliveryFailed);
          }
          return ctx.json({ status: true as const });
        },
      ),
      tbReauthVerifyCode: createAuthEndpoint(
        REAUTH_ROUTES.verifyCode,
        {
          method: "POST",
          body: z.object({ code: z.string().max(64) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const { session, user } = ownSession(ctx);
          await requireMethod(user.id, "emailCode");
          const code = ctx.body.code.trim();
          if (!CODE_RE.test(code)) {
            throw reauthError(
              "BAD_REQUEST",
              REAUTH_ERRORS.invalidCode,
              await availableMethods(user.id, false),
            );
          }
          const result = await checkCode(session.id, code);
          if (result === "ok") {
            return ctx.json(await confirmed(session.id, user.id));
          }
          if (result === "invalid")
            throw await failed(user.id, REAUTH_ERRORS.invalidCode);
          if (result === "exhausted")
            throw await failed(user.id, REAUTH_ERRORS.codeExpired);
          throw reauthError(
            "BAD_REQUEST",
            REAUTH_ERRORS.codeExpired,
            await availableMethods(user.id, false),
          );
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
