import { describe, expect, it } from "vite-plus/test";
import { passkeyMessageKey } from "./passkey-message";

describe("passkeyMessageKey", () => {
  it.each([
    [0, "", "offline"],
    [429, "", "rateLimited"],
    [401, "USER_VERIFICATION_REQUIRED", "userVerificationRequired"],
    [400, "USER_VERIFICATION_REQUIRED", "userVerificationRequired"],
    [400, "PASSKEY_LIMIT_REACHED", "limitReached"],
    [400, "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", "previouslyRegistered"],
    [401, "PASSKEY_NOT_FOUND", "notFound"],
    [400, "ERROR_INVALID_DOMAIN", "wrongAddress"],
    [400, "ERROR_INVALID_RP_ID", "wrongAddress"],
    [500, "UNKNOWN_ERROR", "failed"],
  ])("status %i, code %s → %s", (status, code, key) => {
    expect(passkeyMessageKey({ status, code })).toBe(
      `auth:passkey.errors.${key}`,
    );
  });
});
