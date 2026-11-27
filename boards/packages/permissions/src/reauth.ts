// TB-31 R-5, fresh sign-in: the contract between the API guard and the web
// window «Подтвердите, что это вы». Spec: docs/impl/impl-tb119-profile-login.md,
// R-5 and R-8. The API sets the codes and `methods`; the web reads them from here.

// In the window's order. "passkey" — slice B: the user has a key and the
// install signs in locally (not DISABLE_LOGIN_FORM).
export const REAUTH_METHODS = ["password", "passkey", "emailCode"] as const;
export type ReauthMethod = (typeof REAUTH_METHODS)[number];

// Paths under the better-auth base path (`/api/auth`), all POST with a session cookie.
export const REAUTH_ROUTES = {
  password: "/tb/reauth/password", // checks: allow-secret — route path, not a secret
  sendCode: "/tb/reauth/send-code",
  verifyCode: "/tb/reauth/verify-code",
} as const;

export const REAUTH_ERRORS = {
  // 403 on a guarded action: the session has no fresh mark.
  sessionNotFresh: "SESSION_NOT_FRESH",
  // 400: wrong password; the session stays not fresh.
  invalidPassword: "INVALID_PASSWORD",
  // 400: wrong code; the same code can be tried again.
  invalidCode: "INVALID_CODE",
  // 400: no live code: expired, used up by failed tries, or never sent.
  codeExpired: "CODE_EXPIRED",
  // 400: the method is not in the user's current `methods`.
  methodUnavailable: "METHOD_UNAVAILABLE",
  // 403 on /tb/reauth/*: an impersonated session cannot become fresh.
  impersonated: "IMPERSONATION_NOT_ALLOWED",
  // 502: the code was not sent.
  emailDeliveryFailed: "EMAIL_DELIVERY_FAILED",
  // 403 on /passkey/verify-authentication: the key belongs to another user
  // than the session it should confirm. That session lives on; no new one.
  userMismatch: "REAUTH_USER_MISMATCH",
} as const;
export type ReauthError = (typeof REAUTH_ERRORS)[keyof typeof REAUTH_ERRORS];

// Body of every reauth error. `methods` is the current list for this user and
// comes on SESSION_NOT_FRESH and on each failed try: the window redraws from it.
export type ReauthErrorBody = {
  code: ReauthError;
  message: string;
  methods?: ReauthMethod[];
  // Only on SESSION_NOT_FRESH of an impersonated session (`methods` is empty).
  impersonated?: true;
};

export const REAUTH_FRESH_SECONDS = 5 * 60;
export const REAUTH_CODE_LENGTH = 6;
export const REAUTH_CODE_TTL_SECONDS = 10 * 60;
export const REAUTH_CODE_MAX_TRIES = 5;
// Failed tries of all methods per user per hour; after them only emailCode stays.
export const REAUTH_FAILURE_LIMIT = 10;
export const REAUTH_FAILURE_WINDOW_SECONDS = 60 * 60;
// TB-244: code emails per user per hour, from all IPs and sessions together.
export const REAUTH_SEND_CODE_LIMIT = 5;
export const REAUTH_SEND_CODE_WINDOW_SECONDS = 60 * 60;

export function isReauthMethod(value: unknown): value is ReauthMethod {
  return (REAUTH_METHODS as readonly unknown[]).includes(value);
}

// True for the guard reply; the web opens the window only on it.
export function isSessionNotFresh(
  error: unknown,
): error is ReauthErrorBody & { code: "SESSION_NOT_FRESH" } {
  if (!error || typeof error !== "object") return false;
  const { code, methods } = error as { code?: unknown; methods?: unknown };
  return (
    code === REAUTH_ERRORS.sessionNotFresh &&
    Array.isArray(methods) &&
    methods.every(isReauthMethod)
  );
}
