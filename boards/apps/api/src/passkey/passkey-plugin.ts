import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import {
  addedPasskey,
  notifyPasskeyAdded,
  passkeyAlertEndpoints,
} from "./passkey-alert";
import {
  assertBelowPasskeyLimit,
  cookieSession,
  replaceConfirmedSession,
} from "./passkey-confirm";
import { assertPasskeyNameFits, NAMED_PASSKEY_ROUTES } from "./passkey-name";

const REGISTER_OPTIONS = "/passkey/generate-register-options";
const VERIFY_REGISTRATION = "/passkey/verify-registration";
const AUTHENTICATE_OPTIONS = "/passkey/generate-authenticate-options";
const VERIFY_AUTHENTICATION = "/passkey/verify-authentication";

/**
 * TB-31 R-6: our hooks around `@better-auth/passkey`. The fresh-session
 * guard on registration and deletion is in reauth/guard.ts; the checks that
 * need the verified key are the plugin's `afterVerification` callbacks
 * (passkey-options.ts). The «A passkey was added» email and its «This
 * wasn't me» routes are in passkey-alert.ts.
 */
export function passkeyHooksPlugin({
  clientUrl,
}: {
  clientUrl: string;
}): BetterAuthPlugin {
  return {
    id: "tb-passkey",
    endpoints: passkeyAlertEndpoints,
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
        {
          // TB-260: before the plugin writes the name, on a rename and on a
          // new key alike.
          matcher: (ctx) =>
            ctx.path !== undefined && NAMED_PASSKEY_ROUTES.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            assertPasskeyNameFits(ctx.body);
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
          // The key is stored: the email goes to the account's address.
          matcher: (ctx) => ctx.path === VERIFY_REGISTRATION,
          handler: createAuthMiddleware(async (ctx) => {
            const key = addedPasskey(ctx.context.returned);
            if (!key) return;
            await notifyPasskeyAdded(
              key,
              clientUrl,
              ctx.request?.headers ?? ctx.headers,
            );
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
