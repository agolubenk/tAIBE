// TB-31 R-6, passkeys: the contract between the API (`@better-auth/passkey`
// and its hooks, apps/api/src/passkey/) and the web. Spec:
// docs/impl/impl-tb119-profile-login.md, R-6.

// A user keeps at most this many keys; the next one is refused.
export const PASSKEY_MAX_PER_USER = 10;

export const PASSKEY_ERRORS = {
  // 400 on registration: the user has PASSKEY_MAX_PER_USER keys.
  limitReached: "PASSKEY_LIMIT_REACHED",
  // 401 on sign-in, 400 on registration: the key was used without a PIN or
  // biometrics (the UV flag is not set in the signed authenticator data).
  userVerificationRequired: "USER_VERIFICATION_REQUIRED",
  // 400 on /passkey/verify-registration with `createSession`: the person is
  // signed in already, a second session would be a duplicate.
  sessionNotAllowed: "PASSKEY_SESSION_NOT_ALLOWED",
  // 400 on the «This wasn't me» routes: the link is wrong, used or expired.
  alertInvalid: "PASSKEY_ALERT_INVALID",
} as const;
export type PasskeyError = (typeof PASSKEY_ERRORS)[keyof typeof PASSKEY_ERRORS];

// «This wasn't me» from the «A passkey was added» email. No session: the link
// is the proof. `inspect` changes nothing; `confirm` removes the key, the API
// keys made after it and every session.
export const PASSKEY_ALERT_ROUTES = {
  inspect: "/tb/passkey-alert/inspect",
  confirm: "/tb/passkey-alert/confirm",
} as const;

// The link in the email works this long.
export const PASSKEY_ALERT_TTL_DAYS = 7;

// The web page that opens the link: `${PASSKEY_ALERT_PAGE}#t=<token>`.
export const PASSKEY_ALERT_PAGE = "/account/passkey-alert";

export type PasskeyAlertInspect = {
  keyName: string | null;
  addedAt: string;
  // false — the person has removed the key already; confirm still signs out.
  keyExists: boolean;
};
