import type { DBAdapter } from "better-auth/adapters";
import { APIError } from "better-auth/api";
import { USERNAME_ERROR_CODES } from "better-auth/plugins";

/** The unique index on user.username (migration 0088). */
export const USERNAME_UNIQUE = "user_username_unique";
const UNIQUE_VIOLATION = "23505";
/** Drizzle puts the pg error in `cause`; a few links are enough. */
const CAUSE_DEPTH = 4;

/**
 * TB-248. The username plugin checks a login with findOne before the write.
 * Two requests for the same free login both pass the check, and the second
 * write fails on the unique index. That error is not an APIError, so
 * better-auth answers 500 and skips the after hooks. This gives the plugin's
 * own answer instead: 400 USERNAME_IS_ALREADY_TAKEN, which web shows as
 * «Логин занят». The index keeps the data right; only the answer was wrong.
 */
export function usernameTakenError(error: unknown): APIError | undefined {
  let link: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH; depth++) {
    if (!link || typeof link !== "object") return undefined;
    const { code, constraint, cause } = link as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (code === UNIQUE_VIOLATION && constraint === USERNAME_UNIQUE) {
      return APIError.from(
        "BAD_REQUEST",
        USERNAME_ERROR_CODES.USERNAME_IS_ALREADY_TAKEN,
      );
    }
    link = cause;
  }
  return undefined;
}

async function answerTakenLogin<R>(write: () => Promise<R>): Promise<R> {
  try {
    return await write();
  } catch (error) {
    throw usernameTakenError(error) ?? error;
  }
}

type Writes = Pick<DBAdapter, "create" | "update">;

function withTakenLoginWrites<A extends Writes>(adapter: A): A {
  return {
    ...adapter,
    create: (data) => answerTakenLogin(() => adapter.create(data)),
    update: (data) => answerTakenLogin(() => adapter.update(data)),
  };
}

/**
 * create and update answer a taken login as the plugin does, also inside a
 * transaction: /sign-up/email writes the user in one, /update-user does not.
 * Any other error passes as it was.
 */
export function answerTakenLoginAdapter(adapter: DBAdapter): DBAdapter {
  return {
    ...withTakenLoginWrites(adapter),
    transaction: (callback) =>
      adapter.transaction((trx) => callback(withTakenLoginWrites(trx))),
  };
}
