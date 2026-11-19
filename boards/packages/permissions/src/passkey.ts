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
} as const;
export type PasskeyError = (typeof PASSKEY_ERRORS)[keyof typeof PASSKEY_ERRORS];
