import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import {
  assertBelowPasskeyLimit,
  cookieSession,
  replaceConfirmedSession,
} from "./passkey-confirm";

const REGISTER_OPTIONS = "/passkey/generate-register-options";
const AUTHENTICATE_OPTIONS = "/passkey/generate-authenticate-options";
const VERIFY_AUTHENTICATION = "/passkey/verify-authentication";

/**
 * TB-31 R-6: our hooks around `@better-auth/passkey`. The fresh-session
 * guard on registration and deletion is in reauth/guard.ts; the checks that
 * need the verified key are the plugin's `afterVerification` callbacks
 * (passkey-options.ts).
 */
export function passkeyHooksPlugin(): BetterAuthPlugin {
  return {
    id: "tb-passkey",
    hooks: {
      before: [
        {
          // The 11th key is refused before the ceremony, not after it.
          matcher: (ctx) => ctx.path === REGISTER_OPTIONS,
          handler: createAuthMiddleware(async (ctx) => {
            const current = await cookieSession(ctx);
            if (current) await assertBelowPasskeyLimit(current.session.userId);
          }),
        },
      ],
      after: [
        {
          // The plugin asks for UV as "preferred" on sign-in; the browser
          // must ask for the PIN or biometrics. The challenge cookie stays.
          matcher: (ctx) => ctx.path === AUTHENTICATE_OPTIONS,
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (
              !returned ||
              typeof returned !== "object" ||
              isAPIError(returned) ||
              !("challenge" in returned)
            )
              return;
            return ctx.json({ ...returned, userVerification: "required" });
          }),
        },
        {
          matcher: (ctx) => ctx.path === VERIFY_AUTHENTICATION,
          handler: createAuthMiddleware(async (ctx) => {
            await replaceConfirmedSession(ctx);
          }),
        },
      ],
    },
  };
}
