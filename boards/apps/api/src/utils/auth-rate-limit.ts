import { REAUTH_ROUTES } from "@kaneo/permissions";

type Env = Record<string, string | undefined>;
type Rule = { window: number; max: number };

// TB-31 R-8. better-auth keys a bucket by `ip|path`; the IP comes only from
// `x-kaneo-client-ip`, which `client-ip.ts` sets from TRUSTED_PROXIES.
// Its own rules stay under these: `/sign-in*` 3 per 10 s, password reset and
// verification mail 3 per 60 s (`rate-limiter/index.mjs` 1.7.15). A custom
// rule replaces a plugin's own: `/sign-in/email-otp` keeps the email-otp
// plugin's 3 per 60 s (`plugins/email-otp/index.mjs`), never looser.
export const AUTH_RATE_LIMIT_RULES: Record<string, Rule> = {
  "/sign-up/email": { window: 60, max: 3 },
  "/sign-in/anonymous": { window: 60, max: 3 },
  "/organization/invite-member": { window: 60, max: 5 },
  "/sign-in/email": { window: 60, max: 5 },
  "/sign-in/username": { window: 60, max: 5 },
  "/is-username-available": { window: 60, max: 10 },
  // R-6: options are open without a session and write a `verification` row
  // and a cookie on each call; verification checks a signature.
  "/passkey/generate-authenticate-options": { window: 60, max: 20 },
  "/passkey/verify-authentication": { window: 60, max: 10 },
  "/sign-in/magic-link": { window: 60, max: 3 },
  "/sign-in/email-otp": { window: 60, max: 3 },
  [REAUTH_ROUTES.password]: { window: 60, max: 5 },
  [REAUTH_ROUTES.verifyCode]: { window: 60, max: 5 },
  [REAUTH_ROUTES.sendCode]: { window: 60, max: 3 },
};

// On by default on every install (Q-905); DISABLE_AUTH_RATE_LIMIT=true turns it off.
export function isAuthRateLimitEnabled(env: Env = process.env): boolean {
  return env.DISABLE_AUTH_RATE_LIMIT !== "true";
}

export function authRateLimitOptions(env: Env = process.env) {
  return {
    enabled: isAuthRateLimitEnabled(env),
    window: 10,
    max: 100,
    customRules: AUTH_RATE_LIMIT_RULES,
  };
}

/**
 * One startup line when the limiter cannot tell clients apart or is off.
 * Without TRUSTED_PROXIES only loopback proxies are trusted: behind any other
 * proxy (a docker bridge, a load balancer) every client has the proxy's
 * address, and the whole install shares one bucket per route.
 */
export function authRateLimitWarning(env: Env = process.env): string | null {
  if (!isAuthRateLimitEnabled(env)) {
    return "[auth] DISABLE_AUTH_RATE_LIMIT=true: sign-in has no brute-force limit.";
  }
  if (!env.TRUSTED_PROXIES?.trim()) {
    return "[auth] TRUSTED_PROXIES is not set: only loopback proxies are trusted. Behind another proxy all clients share one rate-limit bucket; set it to the proxy's address (see deploy/vps/README.md).";
  }
  return null;
}
