import { PASSKEY_ERRORS } from "@kaneo/permissions";

// TB-31 R-6: the text of a failed passkey ceremony, on sign-in and in
// «Ключи входа». A closed system window shows nothing (`cancelled`).

export type PasskeyMessageKey = `auth:passkey.errors.${string}`;

const BY_CODE: Record<string, PasskeyMessageKey> = {
  [PASSKEY_ERRORS.userVerificationRequired]:
    "auth:passkey.errors.userVerificationRequired",
  [PASSKEY_ERRORS.limitReached]: "auth:passkey.errors.limitReached",
  // simplewebauthn: the authenticator holds a key of this account already.
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED:
    "auth:passkey.errors.previouslyRegistered",
  // The key was removed here but stays on the device.
  PASSKEY_NOT_FOUND: "auth:passkey.errors.notFound",
  // The site is open by another name or by an IP: the key is bound to rpID.
  ERROR_INVALID_DOMAIN: "auth:passkey.errors.wrongAddress",
  ERROR_INVALID_RP_ID: "auth:passkey.errors.wrongAddress",
};

export function passkeyMessageKey(failure: {
  status: number;
  code: string;
}): PasskeyMessageKey {
  if (failure.status === 0 && !failure.code) {
    return "auth:passkey.errors.offline";
  }
  if (failure.status === 429) return "auth:passkey.errors.rateLimited";
  return BY_CODE[failure.code] ?? "auth:passkey.errors.failed";
}
