import { PASSKEY_ERRORS, REAUTH_ERRORS } from "@kaneo/permissions";
import type { ReauthReply } from "./reauth-api";

type Failure = Extract<ReauthReply, { ok: false }>;

export type ReauthMessage = {
  key: `auth:reauth.errors.${string}`;
  values?: Record<string, number>;
  // CODE_EXPIRED: the code field is cleared and «send a new code» is offered.
  codeGone?: true;
};

const BY_CODE: Record<string, ReauthMessage> = {
  [REAUTH_ERRORS.invalidPassword]: {
    key: "auth:reauth.errors.invalidPassword",
  },
  [REAUTH_ERRORS.invalidCode]: { key: "auth:reauth.errors.invalidCode" },
  [REAUTH_ERRORS.codeExpired]: {
    key: "auth:reauth.errors.codeExpired",
    codeGone: true,
  },
  [REAUTH_ERRORS.methodUnavailable]: {
    key: "auth:reauth.errors.methodUnavailable",
  },
  [REAUTH_ERRORS.emailDeliveryFailed]: {
    key: "auth:reauth.errors.emailDeliveryFailed",
  },
  [REAUTH_ERRORS.impersonated]: { key: "auth:reauth.errors.impersonated" },
  // R-6: the key of another account; the session lives on.
  [REAUTH_ERRORS.userMismatch]: { key: "auth:reauth.errors.userMismatch" },
  // R-6, 401: a key without a PIN or biometrics. Not «signed out».
  [PASSKEY_ERRORS.userVerificationRequired]: {
    key: "auth:reauth.errors.userVerificationRequired",
  },
  // The plugin's other 401s on a key: the session is alive, it is the key.
  PASSKEY_NOT_FOUND: { key: "auth:reauth.errors.passkeyNotFound" },
  AUTHENTICATION_FAILED: { key: "auth:reauth.errors.failed" },
};

/** The text under the field for a failed try (TB-31 R-5, R-8). */
export function reauthMessage(failure: Failure): ReauthMessage {
  if (failure.status === 0) return { key: "auth:reauth.errors.offline" };
  if (failure.status === 429) {
    return failure.retryAfter
      ? {
          key: "auth:reauth.errors.rateLimitedFor",
          values: { seconds: failure.retryAfter },
        }
      : { key: "auth:reauth.errors.rateLimited" };
  }
  const known = BY_CODE[failure.code];
  if (known) return known;
  if (failure.status === 401) return { key: "auth:reauth.errors.signedOut" };
  return { key: "auth:reauth.errors.failed" };
}
