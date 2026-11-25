import type { PasskeyOptions } from "@better-auth/passkey";
import {
  checkPasskeyRegistration,
  confirmPasskeySignIn,
} from "./passkey-confirm";

type Env = Record<string, string | undefined>;

const DEFAULT_CLIENT_URL = "http://localhost:5173";

/**
 * TB-31 R-6. The key is bound to the name the browser opens: `origin` is
 * KANEO_CLIENT_URL, `rpID` is PASSKEY_RP_ID or the host of that URL. A key
 * works only on that name; on another name or an IP the person signs in with
 * the password. A key without a PIN or biometrics is not taken: registration
 * asks for UV, and the hooks check the UV flag on registration and sign-in.
 */
export function passkeyOptions(env: Env = process.env): PasskeyOptions {
  const origin = env.KANEO_CLIENT_URL || DEFAULT_CLIENT_URL;
  return {
    rpID: env.PASSKEY_RP_ID?.trim() || new URL(origin).hostname,
    rpName: "t-boards",
    origin,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    registration: { afterVerification: checkPasskeyRegistration },
    authentication: { afterVerification: confirmPasskeySignIn },
  };
}
