import { describe, expect, it } from "vite-plus/test";
import { isReauthMethod, isSessionNotFresh, REAUTH_ERRORS } from "./reauth";

describe("reauth contract", () => {
  it("accepts only the contract methods", () => {
    expect(isReauthMethod("password")).toBe(true);
    expect(isReauthMethod("emailCode")).toBe(true);
    expect(isReauthMethod("passkey")).toBe(true);
    expect(isReauthMethod("webauthn")).toBe(false);
    expect(isReauthMethod(undefined)).toBe(false);
  });

  it("recognizes the guard reply with methods", () => {
    expect(
      isSessionNotFresh({
        code: REAUTH_ERRORS.sessionNotFresh,
        message: "Confirm it is you",
        methods: ["password", "emailCode"],
      }),
    ).toBe(true);
    expect(
      isSessionNotFresh({
        code: "SESSION_NOT_FRESH",
        message: "",
        methods: [],
        impersonated: true,
      }),
    ).toBe(true);
  });

  it("ignores a reply without a valid methods list", () => {
    // better-auth's own freshSessionMiddleware reply has no methods.
    expect(isSessionNotFresh({ code: "SESSION_NOT_FRESH", message: "x" })).toBe(
      false,
    );
    expect(
      isSessionNotFresh({ code: "SESSION_NOT_FRESH", methods: ["sms"] }),
    ).toBe(false);
    expect(isSessionNotFresh({ code: "INVALID_PASSWORD", methods: [] })).toBe(
      false,
    );
    expect(isSessionNotFresh(null)).toBe(false);
    expect(isSessionNotFresh("SESSION_NOT_FRESH")).toBe(false);
  });
});
