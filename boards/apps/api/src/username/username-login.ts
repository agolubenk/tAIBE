import {
  isAllowedUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "@kaneo/permissions";
import { APIError } from "better-auth/api";
import type { UsernameOptions } from "better-auth/plugins";
import type { SessionResolver } from "../reauth/guard";

/**
 * TB-31 R-1. The plugin stores `username` in lower case and
 * `displayUsername` as typed. The validators run before normalization, so
 * "Admin" is refused like "admin". Spec: impl-tb119-profile-login.md, R-1.
 */
export const USERNAME_PLUGIN_OPTIONS = {
  minUsernameLength: USERNAME_MIN_LENGTH,
  maxUsernameLength: USERNAME_MAX_LENGTH,
  usernameValidator: (value: string) => isAllowedUsername(value),
  displayUsernameValidator: (value: string) => isAllowedUsername(value),
} satisfies UsernameOptions;

const LOGIN_FIELDS = ["username", "displayUsername"] as const;

/** True if the body sets the login: the plugin acts on either field. */
export function setsLogin(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return LOGIN_FIELDS.some((field) => Object.hasOwn(body, field));
}

type LoginBody = { username?: unknown; displayUsername?: unknown };

function isSameLogin({ username, displayUsername }: LoginBody): boolean {
  return (
    typeof username === "string" &&
    typeof displayUsername === "string" &&
    username.toLowerCase() === displayUsername.toLowerCase()
  );
}

type RequestContext = {
  path: string;
  body?: unknown;
  request?: Request;
  headers?: Headers;
};

/**
 * Runs before the plugin's hooks.
 * - `/is-username-available` answers only a signed-in person, else 401:
 *   without a session it would list the logins of an install.
 * - `/update-user` sets the login only as a pair, `username` and
 *   `displayUsername` equal but for case. The plugin stores each as sent, and
 *   a pair that differs would show one login and sign in with another.
 * - `/sign-up/email` with both fields: the same pair. With one field the
 *   plugin makes the other from it.
 * Server-side `auth.api.*` calls carry no request and pass.
 */
export async function assertUsernameRequest(
  ctx: RequestContext,
  resolveSession: SessionResolver,
): Promise<void> {
  if (ctx.path === "/is-username-available") {
    if (!ctx.request) return;
    const found = await resolveSession(ctx.headers ?? ctx.request.headers);
    if (found?.session) return;
    throw new APIError("UNAUTHORIZED", {
      code: "UNAUTHORIZED",
      message: "Sign in to check a login.",
    });
  }
  if (ctx.path !== "/update-user" && ctx.path !== "/sign-up/email") return;
  if (!setsLogin(ctx.body)) return;
  const body = ctx.body as LoginBody;
  const onlyOne =
    body.username === undefined || body.displayUsername === undefined;
  if (ctx.path === "/sign-up/email" && onlyOne) return;
  if (isSameLogin(body)) return;
  throw new APIError("BAD_REQUEST", {
    code: "INVALID_DISPLAY_USERNAME",
    message:
      "Send the login as username and displayUsername, equal but for case.",
  });
}
