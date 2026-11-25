import {
  isReauthMethod,
  REAUTH_ROUTES,
  type ReauthMethod,
} from "@kaneo/permissions";
import { authClient } from "@/lib/auth-client";

export type ReauthStep = keyof typeof REAUTH_ROUTES;

export type ReauthReply =
  | { ok: true }
  | {
      ok: false;
      // 0: no answer from the server (offline, DNS, CORS).
      status: number;
      code: string;
      // The current methods of this person: the window redraws from them.
      methods?: ReauthMethod[];
      retryAfter?: number;
    };

type ErrorFields = { status?: number; code?: unknown; methods?: unknown };

/** The `methods` of an error body, if it is a list of known methods. */
export function reauthMethodsOf(value: unknown): ReauthMethod[] | undefined {
  return Array.isArray(value) && value.every(isReauthMethod)
    ? value
    : undefined;
}

/**
 * TB-31 R-5: one POST to /tb/reauth/*. Success makes the current session
 * fresh for 5 minutes; no new session, no new cookie. Plain `$fetch`, not a
 * client plugin: the same base URL and cookies, and nothing in the main bundle.
 */
export async function postReauth(
  step: ReauthStep,
  body: Record<string, string> = {},
): Promise<ReauthReply> {
  let retryAfter: number | undefined;
  try {
    const { error } = await authClient.$fetch(REAUTH_ROUTES[step], {
      method: "POST",
      body,
      onError: ({ response }) => {
        const seconds = Number(response.headers.get("Retry-After"));
        if (Number.isFinite(seconds) && seconds > 0) {
          retryAfter = Math.ceil(seconds);
        }
      },
    });
    if (!error) return { ok: true };
    const fields = error as ErrorFields;
    return {
      ok: false,
      status: fields.status ?? 0,
      code: typeof fields.code === "string" ? fields.code : "",
      methods: reauthMethodsOf(fields.methods),
      retryAfter,
    };
  } catch {
    return { ok: false, status: 0, code: "" };
  }
}
