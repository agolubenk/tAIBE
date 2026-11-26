import type { DBAdapter } from "better-auth/adapters";
import { isAPIError } from "better-auth/api";
import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import {
  answerTakenLoginAdapter,
  USERNAME_UNIQUE,
  usernameTakenError,
} from "./username-taken";

// The shape node-postgres gives a unique violation (DatabaseError).
function uniqueViolation(constraint: string) {
  return Object.assign(new Error(`duplicate key violates "${constraint}"`), {
    code: "23505",
    constraint,
  });
}

function expectTaken(error: unknown) {
  expect(isAPIError(error)).toBe(true);
  const api = error as { statusCode: number; body?: { code?: string } };
  expect(api.statusCode).toBe(400);
  expect(api.body?.code).toBe("USERNAME_IS_ALREADY_TAKEN");
}

describe("TB-248: usernameTakenError", () => {
  it("answers the login index violation, also wrapped by drizzle", () => {
    const pg = uniqueViolation(USERNAME_UNIQUE);
    expectTaken(usernameTakenError(pg));
    expectTaken(
      usernameTakenError(new DrizzleQueryError("update ...", ["ivan42"], pg)),
    );
  });

  it("leaves other errors alone", () => {
    expect(usernameTakenError(uniqueViolation("user_email_unique"))).toBe(
      undefined,
    );
    const foreignKey = Object.assign(uniqueViolation(USERNAME_UNIQUE), {
      code: "23503",
    });
    expect(usernameTakenError(foreignKey)).toBe(undefined);
    expect(usernameTakenError(new Error("boom"))).toBe(undefined);
    expect(usernameTakenError(null)).toBe(undefined);
    expect(usernameTakenError("23505")).toBe(undefined);
  });

  it("stops on a cause chain that loops", () => {
    const first: { cause?: unknown } = {};
    first.cause = { cause: first };
    expect(usernameTakenError(first)).toBe(undefined);
  });
});

describe("TB-248: answerTakenLoginAdapter", () => {
  const pg = uniqueViolation(USERNAME_UNIQUE);
  const other = new Error("connection lost");

  function fakeAdapter(fail: unknown) {
    const writes = {
      create: async () => {
        throw fail;
      },
      update: async () => {
        throw fail;
      },
    };
    const trxSeen: unknown[] = [];
    const adapter = {
      id: "fake",
      ...writes,
      findOne: async () => ({ id: "u1" }),
      transaction: async (callback: (trx: unknown) => Promise<unknown>) => {
        const trx = { ...writes, findOne: async () => null };
        trxSeen.push(trx);
        return callback(trx);
      },
    } as unknown as DBAdapter;
    return { adapter, trxSeen };
  }

  const create = { model: "user", data: { username: "ivan42" } };
  const update = {
    model: "user",
    where: [{ field: "id", value: "u2" }],
    update: { username: "ivan42" },
  };

  it("answers 400 on create and update, outside and inside a transaction", async () => {
    const { adapter } = fakeAdapter(pg);
    const wrapped = answerTakenLoginAdapter(adapter);
    expectTaken(await wrapped.create(create).catch((error) => error));
    expectTaken(await wrapped.update(update).catch((error) => error));
    const inside = await wrapped
      .transaction((trx) => trx.update(update))
      .catch((error) => error);
    expectTaken(inside);
    const created = await wrapped
      .transaction((trx) => trx.create(create))
      .catch((error) => error);
    expectTaken(created);
  });

  it("passes any other error and every other method as they were", async () => {
    const { adapter } = fakeAdapter(other);
    const wrapped = answerTakenLoginAdapter(adapter);
    await expect(wrapped.update(update)).rejects.toBe(other);
    await expect(wrapped.transaction((trx) => trx.create(create))).rejects.toBe(
      other,
    );
    expect(wrapped.findOne).toBe(adapter.findOne);
    expect(wrapped.id).toBe("fake");
  });

  it("returns what the write returns", async () => {
    const row = { id: "u2", username: "ivan42" };
    const adapter = {
      create: async () => row,
      update: async () => row,
      transaction: async (callback: (trx: unknown) => Promise<unknown>) =>
        callback({ update: async () => row, create: async () => row }),
    } as unknown as DBAdapter;
    const wrapped = answerTakenLoginAdapter(adapter);
    expect(await wrapped.update(update)).toBe(row);
    expect(await wrapped.transaction((trx) => trx.create(create))).toBe(row);
  });
});
