import { authClient } from "@/lib/auth-client";
import { resolveSignInEmail, signInRoute } from "./local-admin-login";

// TB-31 R-1, R-8: the password sign-in with an email or a login, and the text
// for each failure. Spec: docs/impl/impl-tb119-profile-login.md, R-1, AC-3, AC-13.

export type SignInFailure = {
  // 0: no answer from the server (offline, DNS, CORS).
  status: number;
  code: string;
  message: string;
  retryAfter?: number;
};

export type SignInResult = { ok: true } | ({ ok: false } & SignInFailure);

export type SignInMessage =
  | { key: `auth:signInForm.${string}`; values?: Record<string, number> }
  | { text: string };

// A wrong login and a wrong password read the same. The login rule codes
// come only from a form bypassed by hand; they say nothing of an account.
const WRONG_LOGIN_OR_PASSWORD = new Set([
  "INVALID_EMAIL_OR_PASSWORD",
  "INVALID_USERNAME_OR_PASSWORD",
  "INVALID_USERNAME",
  "USERNAME_TOO_SHORT",
  "USERNAME_TOO_LONG",
  "INVALID_EMAIL",
]);

/**
 * 429 is not «wrong password»: a person with the right password would go
 * and reset it after the fifth try (spec R-1).
 */
export function signInMessage(failure: SignInFailure): SignInMessage {
  if (failure.status === 0) return { key: "auth:signInForm.offline" };
  if (failure.status === 429) {
    return failure.retryAfter
      ? {
          key: "auth:signInForm.rateLimitedFor",
          values: { seconds: failure.retryAfter },
        }
      : { key: "auth:signInForm.rateLimited" };
  }
  if (failure.status === 401 || WRONG_LOGIN_OR_PASSWORD.has(failure.code)) {
    return { key: "auth:signInForm.invalidCredentials" };
  }
  if (failure.message) return { text: failure.message };
  return { key: "auth:signInForm.failedSignIn" };
}

type ErrorFields = { status?: number; code?: unknown; message?: unknown };

/** One sign-in request: `/sign-in/email` for a value with `@`, else `/sign-in/username`. */
export async function signInWithPassword(
  login: string,
  password: string,
  headers?: Record<string, string>,
): Promise<SignInResult> {
  let retryAfter: number | undefined;
  const fetchOptions = {
    headers,
    onError: ({ response }: { response: Response }) => {
      const seconds = Number(response.headers.get("Retry-After"));
      if (Number.isFinite(seconds) && seconds > 0) {
        retryAfter = Math.ceil(seconds);
      }
    },
  };
  try {
    const { error } =
      signInRoute(login) === "email"
        ? await authClient.signIn.email(
            { email: resolveSignInEmail(login), password },
            fetchOptions,
          )
        : await authClient.signIn.username(
            { username: login.trim(), password },
            fetchOptions,
          );
    if (!error) return { ok: true };
    const fields = error as ErrorFields;
    return {
      ok: false,
      status: fields.status ?? 0,
      code: typeof fields.code === "string" ? fields.code : "",
      message: typeof fields.message === "string" ? fields.message : "",
      retryAfter,
    };
  } catch {
    return { ok: false, status: 0, code: "", message: "" };
  }
}
