import {
  getAuthenticatorName,
  type PasskeyOptions,
} from "@better-auth/passkey";
import {
  PASSKEY_ERRORS,
  PASSKEY_MAX_PER_USER,
  REAUTH_ERRORS,
} from "@kaneo/permissions";
import { APIError } from "better-auth/api";
import { availableMethods } from "../reauth/methods";
import {
  failureCount,
  isLockedOut,
  recordFailure,
  resetFailures,
} from "../reauth/store";
import { passkeyCount, passkeyOwner } from "./passkey-store";

type AfterAuthentication = NonNullable<
  NonNullable<PasskeyOptions["authentication"]>["afterVerification"]
>;
type AfterRegistration = NonNullable<
  NonNullable<PasskeyOptions["registration"]>["afterVerification"]
>;
export type EndpointContext = Parameters<AfterAuthentication>[0]["ctx"];

/**
 * The live session of the request's own cookie. On a passkey sign-in it is
 * the session the key confirms (R-5 window); none — a sign-in on the sign-in
 * page. The bearer plugin has already put a Bearer token into the cookie.
 */
export async function cookieSession(ctx: EndpointContext) {
  const token = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret,
  );
  if (!token) return null;
  const found = await ctx.context.internalAdapter.findSession(token);
  if (!found || found.session.expiresAt <= new Date()) return null;
  return found;
}

function impersonated(session: object): boolean {
  return Boolean(
    (session as { impersonatedBy?: string | null }).impersonatedBy,
  );
}

/**
 * `authentication.afterVerification`: runs after the signature check, before
 * the counter update and the new session. The UV flag comes from the signed
 * authenticator data, so it cannot be forged (the plugin itself checks with
 * `requireUserVerification: false`). With a live session in the cookie the
 * key confirms that session (R-5): it must be the same user's key. A refused
 * key creates no session and sets no cookie.
 */
export const confirmPasskeySignIn: AfterAuthentication = async ({
  ctx,
  verification,
  clientData,
}) => {
  if (!verification.authenticationInfo.userVerified) {
    throw new APIError("UNAUTHORIZED", {
      code: PASSKEY_ERRORS.userVerificationRequired,
      message: "Use the key with its PIN or biometrics.",
    });
  }
  const current = await cookieSession(ctx);
  if (!current) return;
  const userId = current.session.userId;
  if (impersonated(current.session)) {
    throw new APIError("FORBIDDEN", {
      code: REAUTH_ERRORS.impersonated,
      message: "Protected actions are not available under another user's name.",
    });
  }
  if (isLockedOut(await failureCount(userId))) {
    throw new APIError("BAD_REQUEST", {
      code: REAUTH_ERRORS.methodUnavailable,
      message: "This way to confirm is not available.",
      methods: await availableMethods(userId, false),
    });
  }
  if ((await passkeyOwner(clientData.id)) !== userId) {
    await recordFailure(userId);
    throw new APIError("FORBIDDEN", {
      code: REAUTH_ERRORS.userMismatch,
      message: "This key belongs to another account.",
      methods: await availableMethods(userId, false),
    });
  }
};

/**
 * After a confirmation by key the browser has a new fresh session (the
 * session hook marks `/passkey/verify-authentication`). The one it confirmed
 * is revoked: no duplicate in the sessions list, and a copied old cookie dies.
 */
export async function replaceConfirmedSession(
  ctx: EndpointContext,
): Promise<void> {
  const fresh = ctx.context.newSession;
  if (!fresh) return;
  const previous = await cookieSession(ctx);
  if (
    !previous ||
    previous.session.id === fresh.session.id ||
    previous.session.userId !== fresh.user.id
  )
    return;
  await ctx.context.internalAdapter.deleteSession(previous.session.token);
  await resetFailures(fresh.user.id);
}

/** 400 when the user already has PASSKEY_MAX_PER_USER keys. */
export async function assertBelowPasskeyLimit(userId: string): Promise<void> {
  if ((await passkeyCount(userId)) < PASSKEY_MAX_PER_USER) return;
  throw new APIError("BAD_REQUEST", {
    code: PASSKEY_ERRORS.limitReached,
    message: "Remove a key you do not use.",
  });
}

/**
 * `registration.afterVerification`: a key without a PIN or biometrics is not
 * taken, the limit is checked once more (two tabs), and the signed-in person
 * gets no second session. A key without a name from the browser gets its
 * provider's name by `aaguid`; an unknown one stays unnamed, and the web and
 * the email call it «Passkey from <date>».
 */
export const checkPasskeyRegistration: AfterRegistration = async ({
  ctx,
  verification,
  user,
}) => {
  if ((ctx.body as { createSession?: unknown } | undefined)?.createSession) {
    throw new APIError("BAD_REQUEST", {
      code: PASSKEY_ERRORS.sessionNotAllowed,
      message: "You are signed in already.",
    });
  }
  if (!verification.registrationInfo?.userVerified) {
    throw new APIError("BAD_REQUEST", {
      code: PASSKEY_ERRORS.userVerificationRequired,
      message: "Use the key with its PIN or biometrics.",
    });
  }
  await assertBelowPasskeyLimit(user.id);
  const name = getAuthenticatorName(verification.registrationInfo.aaguid);
  return name ? { name } : undefined;
};
