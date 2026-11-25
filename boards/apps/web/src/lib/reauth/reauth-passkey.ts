import { signInWithPasskey } from "@/lib/passkey/passkey-client";
import type { ReauthReply } from "./reauth-api";

/**
 * TB-31 R-5 by passkey: a sign-in with a key while the session is live. The
 * server checks that the key is this user's and replaces the session with a
 * fresh one (new cookie). null: the person closed the system window, so the
 * window shows nothing (spec R-6).
 */
export async function reauthWithPasskey(): Promise<ReauthReply | null> {
  const reply = await signInWithPasskey();
  if (reply.ok) return { ok: true };
  if (reply.cancelled) return null;
  return {
    ok: false,
    status: reply.status,
    code: reply.code,
    methods: reply.methods,
  };
}
