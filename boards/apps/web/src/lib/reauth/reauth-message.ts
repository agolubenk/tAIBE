import { REAUTH_ERRORS } from "@kaneo/permissions";
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
  if (failure.status === 401) return { key: "auth:reauth.errors.signedOut" };
  return BY_CODE[failure.code] ?? { key: "auth:reauth.errors.failed" };
}
