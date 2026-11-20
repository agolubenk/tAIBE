import { describe, expect, it } from "vite-plus/test";
import { reauthMessage } from "./reauth-message";

function failure(
  status: number,
  code = "",
  extra: { retryAfter?: number } = {},
) {
  return { ok: false as const, status, code, ...extra };
}

describe("reauthMessage", () => {
  it("names a wrong password and a wrong code", () => {
    expect(reauthMessage(failure(400, "INVALID_PASSWORD")).key).toBe(
      "auth:reauth.errors.invalidPassword",
    );
    expect(reauthMessage(failure(400, "INVALID_CODE"))).toEqual({
      key: "auth:reauth.errors.invalidCode",
    });
  });

  it("clears the code only when it no longer works", () => {
    expect(reauthMessage(failure(400, "CODE_EXPIRED"))).toEqual({
      key: "auth:reauth.errors.codeExpired",
      codeGone: true,
    });
  });

  it("gives the wait from Retry-After on 429", () => {
    expect(
      reauthMessage(failure(429, "RATE_LIMITED", { retryAfter: 30 })),
    ).toEqual({
      key: "auth:reauth.errors.rateLimitedFor",
      values: { seconds: 30 },
    });
    expect(reauthMessage(failure(429, "RATE_LIMITED")).key).toBe(
      "auth:reauth.errors.rateLimited",
    );
  });

  it("tells no answer, a lost session and a refused window apart", () => {
    expect(reauthMessage(failure(0)).key).toBe("auth:reauth.errors.offline");
    expect(reauthMessage(failure(401)).key).toBe(
      "auth:reauth.errors.signedOut",
    );
    expect(reauthMessage(failure(403, "IMPERSONATION_NOT_ALLOWED")).key).toBe(
      "auth:reauth.errors.impersonated",
    );
    expect(reauthMessage(failure(502, "EMAIL_DELIVERY_FAILED")).key).toBe(
      "auth:reauth.errors.emailDeliveryFailed",
    );
  });

  it("falls back for an unknown reply", () => {
    expect(reauthMessage(failure(500, "BOOM")).key).toBe(
      "auth:reauth.errors.failed",
    );
  });

  it("reads a 401 of a key by its code, not as a sign-out (R-6)", () => {
    expect(reauthMessage(failure(401, "USER_VERIFICATION_REQUIRED")).key).toBe(
      "auth:reauth.errors.userVerificationRequired",
    );
    expect(reauthMessage(failure(401, "PASSKEY_NOT_FOUND")).key).toBe(
      "auth:reauth.errors.passkeyNotFound",
    );
    expect(reauthMessage(failure(401, "AUTHENTICATION_FAILED")).key).toBe(
      "auth:reauth.errors.failed",
    );
    expect(reauthMessage(failure(403, "REAUTH_USER_MISMATCH")).key).toBe(
      "auth:reauth.errors.userMismatch",
    );
    expect(reauthMessage(failure(401)).key).toBe(
      "auth:reauth.errors.signedOut",
    );
  });
});
