import type { passkeyClient } from "@better-auth/passkey/client";
import type { ReauthMethod } from "@kaneo/permissions";
import { authClient } from "@/lib/auth-client";
import { reauthMethodsOf } from "@/lib/reauth/reauth-api";

// TB-31 R-6: the two ceremonies of a passkey, sign-in and adding a key. The
// plugin client and @simplewebauthn/browser load through import() on the
// first press, not with the app: in the main client they would add 4.6 KB
// gzip to every page (spec R-6). They run on the main client's fetch and
// store, so a sign-in with a key updates the session the app shows.

type Ceremonies = ReturnType<ReturnType<typeof passkeyClient>["getActions"]>;

export type PasskeyReply =
  | { ok: true }
  | {
      ok: false;
      // The person closed the system window, or it timed out: no message.
      cancelled: boolean;
      // 0: no answer from the server, or the code did not load.
      status: number;
      code: string;
      // On SESSION_NOT_FRESH and on a failed confirmation (R-5).
      methods?: ReauthMethod[];
      impersonated?: boolean;
    };

// simplewebauthn passes NotAllowedError (cancel, timeout) through under the
// first code; the plugin reports any other failure of the ceremony itself as
// AUTH_CANCELLED.
const CANCELLED = new Set([
  "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
  "ERROR_CEREMONY_ABORTED",
  "AUTH_CANCELLED",
]);

/** WebAuthn in this browser. Without it the passkey UI is hidden. */
export function supportsPasskeys(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function"
  );
}

let loaded: Promise<Ceremonies> | null = null;

function ceremonies(): Promise<Ceremonies> {
  if (!loaded) {
    loaded = import("@better-auth/passkey/client").then(({ passkeyClient }) =>
      passkeyClient().getActions(authClient.$fetch, authClient.$store),
    );
    // A chunk that did not load is tried again on the next press.
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}

type ClientError = {
  status?: number;
  code?: unknown;
  methods?: unknown;
  impersonated?: unknown;
};

export function passkeyReply(error: ClientError | null): PasskeyReply {
  if (!error) return { ok: true };
  const code = typeof error.code === "string" ? error.code : "";
  return {
    ok: false,
    cancelled: CANCELLED.has(code),
    status: error.status ?? 0,
    code,
    methods: reauthMethodsOf(error.methods),
    impersonated: error.impersonated === true,
  };
}

async function attempt(
  run: (actions: Ceremonies) => Promise<{ error: unknown }>,
): Promise<PasskeyReply> {
  try {
    const { error } = await run(await ceremonies());
    return passkeyReply(error as ClientError | null);
  } catch {
    return { ok: false, cancelled: false, status: 0, code: "" };
  }
}

/**
 * Sign-in with a key. With a live session it is the R-5 confirmation: the
 * server replaces that session with a fresh one. The browser asks for the
 * PIN or biometrics (the server requires UV).
 */
export function signInWithPasskey(): Promise<PasskeyReply> {
  return attempt((actions) => actions.signIn.passkey());
}

/**
 * Adds a key to the signed-in account. Call it from a press: Safari and iOS
 * create a key only in answer to a gesture.
 */
export function addPasskey(): Promise<PasskeyReply> {
  return attempt((actions) => actions.passkey.addPasskey());
}
