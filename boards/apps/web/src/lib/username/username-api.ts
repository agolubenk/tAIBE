import type { UsernameProblem } from "@kaneo/permissions";
import { authClient } from "@/lib/auth-client";
import { throwIfNotFresh } from "@/lib/reauth/reauth-errors";

// TB-31 R-1: the login check and the login save. Spec:
// docs/impl/impl-tb119-profile-login.md, R-1, AC-2, AC-4.

/** What the field says after the server answered. */
export type LoginProblem =
  | UsernameProblem
  | "taken"
  | "rateLimited"
  | "offline"
  | "failed";

export type LoginNotice = { problem: LoginProblem; retryAfter?: number };

type ErrorFields = { status?: number; code?: unknown };

const BY_CODE: Record<string, LoginProblem> = {
  USERNAME_IS_ALREADY_TAKEN: "taken",
  USERNAME_TOO_SHORT: "tooShort",
  USERNAME_TOO_LONG: "tooLong",
  // The browser checks the rule first: here it is a reserved name.
  INVALID_USERNAME: "reserved",
  INVALID_DISPLAY_USERNAME: "reserved",
};

/** 429 is not «taken», and no answer is not «taken» either (spec R-1). */
export function noticeOf(error: unknown, retryAfter?: number): LoginNotice {
  const fields = (error ?? {}) as ErrorFields;
  const status = fields.status ?? 0;
  if (status === 0) return { problem: "offline" };
  if (status === 429) return { problem: "rateLimited", retryAfter };
  const code = typeof fields.code === "string" ? fields.code : "";
  return { problem: BY_CODE[code] ?? "failed" };
}

function retryAfterReader() {
  const state: { seconds?: number } = {};
  return {
    state,
    onError: ({ response }: { response: Response }) => {
      const seconds = Number(response.headers.get("Retry-After"));
      if (Number.isFinite(seconds) && seconds > 0) {
        state.seconds = Math.ceil(seconds);
      }
    },
  };
}

/** One request: null if the login is free, else why the field cannot take it. */
export async function checkUsername(
  username: string,
): Promise<LoginNotice | null> {
  const reader = retryAfterReader();
  try {
    const { data, error } = await authClient.isUsernameAvailable(
      { username },
      { onError: reader.onError },
    );
    if (error) return noticeOf(error, reader.state.seconds);
    return data?.available ? null : { problem: "taken" };
  } catch {
    return { problem: "offline" };
  }
}

export class LoginSaveError extends Error {
  readonly notice: LoginNotice;

  constructor(notice: LoginNotice) {
    super(notice.problem);
    this.name = "LoginSaveError";
    this.notice = notice;
  }
}

/**
 * Saves the login as the server wants it: `username` and `displayUsername`
 * as typed. A stale session throws SessionNotFreshError for `useFreshSession`.
 */
export async function saveUsername(login: string): Promise<void> {
  const reader = retryAfterReader();
  let result: Awaited<ReturnType<typeof authClient.updateUser>>;
  try {
    result = await authClient.updateUser(
      { username: login, displayUsername: login },
      { onError: reader.onError },
    );
  } catch {
    throw new LoginSaveError({ problem: "offline" });
  }
  if (!result.error) return;
  throwIfNotFresh(result.error);
  throw new LoginSaveError(noticeOf(result.error, reader.state.seconds));
}
