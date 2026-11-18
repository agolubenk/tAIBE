import { describe, expect, it } from "vite-plus/test";
import {
  AUTH_RATE_LIMIT_RULES,
  authRateLimitOptions,
  authRateLimitWarning,
  isAuthRateLimitEnabled,
} from "./auth-rate-limit";

describe("auth rate limit (TB-31 R-8)", () => {
  it("is on by default and off only with DISABLE_AUTH_RATE_LIMIT=true", () => {
    expect(isAuthRateLimitEnabled({})).toBe(true);
    expect(isAuthRateLimitEnabled({ DISABLE_AUTH_RATE_LIMIT: "" })).toBe(true);
    expect(isAuthRateLimitEnabled({ DISABLE_AUTH_RATE_LIMIT: "1" })).toBe(true);
    expect(isAuthRateLimitEnabled({ DISABLE_AUTH_RATE_LIMIT: "true" })).toBe(
      false,
    );
    // Cloud mode no longer decides it.
    expect(authRateLimitOptions({ KANEO_CLOUD: "false" }).enabled).toBe(true);
  });

  it("holds the spec limits for sign-in and the reauth routes", () => {
    expect(AUTH_RATE_LIMIT_RULES["/sign-in/email"]).toEqual({
      window: 60,
      max: 5,
    });
    expect(AUTH_RATE_LIMIT_RULES["/sign-in/username"]).toEqual({
      window: 60,
      max: 5,
    });
    expect(AUTH_RATE_LIMIT_RULES["/sign-in/magic-link"]).toEqual({
      window: 60,
      max: 3,
    });
    // The email-otp plugin's own limit; a custom rule must not loosen it.
    expect(AUTH_RATE_LIMIT_RULES["/sign-in/email-otp"]).toEqual({
      window: 60,
      max: 3,
    });
    expect(AUTH_RATE_LIMIT_RULES["/tb/reauth/password"]).toEqual({
      window: 60,
      max: 5,
    });
    expect(AUTH_RATE_LIMIT_RULES["/tb/reauth/verify-code"]).toEqual({
      window: 60,
      max: 5,
    });
    expect(AUTH_RATE_LIMIT_RULES["/tb/reauth/send-code"]).toEqual({
      window: 60,
      max: 3,
    });
    // The earlier fork rules stay.
    expect(AUTH_RATE_LIMIT_RULES["/sign-up/email"]).toEqual({
      window: 60,
      max: 3,
    });
    expect(AUTH_RATE_LIMIT_RULES["/organization/invite-member"]).toEqual({
      window: 60,
      max: 5,
    });
  });

  it("warns once at start when clients cannot be told apart or the limit is off", () => {
    expect(authRateLimitWarning({})).toMatch(/TRUSTED_PROXIES is not set/);
    expect(authRateLimitWarning({ TRUSTED_PROXIES: "  " })).toMatch(
      /TRUSTED_PROXIES is not set/,
    );
    expect(authRateLimitWarning({ DISABLE_AUTH_RATE_LIMIT: "true" })).toMatch(
      /no brute-force limit/,
    );
    expect(
      authRateLimitWarning({
        TRUSTED_PROXIES: "10.78.0.1/32,127.0.0.0/8,::1/128",
      }),
    ).toBeNull();
  });
});
