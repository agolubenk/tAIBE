import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  PASSKEY_ERRORS,
  PASSKEY_NAME_MAX,
} from "../../packages/permissions/src";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { failureCount } from "../../apps/api/src/reauth/store";
import { resetTestDatabase } from "./helpers/database";
import {
  countSessions,
  expectError,
  expectNotFresh,
  get,
  person,
  post,
  sessionIdOf,
  staleSessions,
} from "./helpers/reauth";
import {
  register,
  sessionCookieSet,
  signInWithKey,
  withCookies,
} from "./helpers/passkey-flow";
import { SoftPasskey } from "./helpers/soft-passkey";

// TB-31 R-6: passkeys. Spec: docs/impl/impl-tb119-profile-login.md, R-5, R-6.
beforeEach(async () => {
  await resetTestDatabase();
});

async function keyNames(userId: string) {
  const rows = await db
    .select({ name: schema.passkeyTable.name })
    .from(schema.passkeyTable)
    .where(eq(schema.passkeyTable.userId, userId));
  return rows.map((row) => row.name);
}

async function storedCounter(credentialId: string) {
  const [row] = await db
    .select({ counter: schema.passkeyTable.counter })
    .from(schema.passkeyTable)
    .where(eq(schema.passkeyTable.credentialID, credentialId));
  return row?.counter;
}

describe("TB-31 R-6: passkeys", () => {
  it("adds a key and signs in with it; asks the browser for UV", async () => {
    const { app } = createApp();
    const ivan = await person(app);
    const key = new SoftPasskey();

    const added = await register(app, ivan.cookies, key);
    expect(added.status, await added.clone().text()).toBe(200);
    expect(await added.json()).toMatchObject({
      userId: ivan.userId,
      name: "Laptop",
      credentialID: key.credentialId,
    });

    const { challenge, finished } = await signInWithKey(app, "", key);
    expect(challenge.userVerification).toBe("required");
    expect(challenge.allowCredentials).toBeUndefined();
    expect(finished.status, await finished.clone().text()).toBe(200);
    expect(sessionCookieSet(finished)).toBe(true);
    const body = (await finished.json()) as { user: { id: string } };
    expect(body.user.id).toBe(ivan.userId);
  });

  it("stores a counter above 2147483647 and reads it back as a number (coord 22:32)", async () => {
    const { app } = createApp();
    const ivan = await person(app);
    const key = new SoftPasskey();
    expect((await register(app, ivan.cookies, key)).status).toBe(200);

    const first = await signInWithKey(app, "", key, { counter: 3_000_000_000 });
    expect(first.finished.status).toBe(200);
    expect(await storedCounter(key.credentialId)).toBe(3_000_000_000);

    const cookies = withCookies("", first.finished);
    const listed = await get(app, "/passkey/list-user-passkeys", cookies);
    const [listedKey] = (await listed.json()) as { counter: unknown }[];
    expect(listedKey?.counter).toBe(3_000_000_000);

    // The plugin compares the stored counter: a higher one passes, a replay
    // with a lower one is refused.
    const next = await signInWithKey(app, "", key, { counter: 3_000_000_001 });
    expect(next.finished.status).toBe(200);
    const replay = await signInWithKey(app, "", key, { counter: 5 });
    await expectError(replay.finished, 400, "AUTHENTICATION_FAILED");
    expect(await storedCounter(key.credentialId)).toBe(3_000_000_001);
  });

  it("refuses a key used without a PIN or biometrics", async () => {
    const { app } = createApp();
    const ivan = await person(app);

    await expectError(
      await register(app, ivan.cookies, new SoftPasskey(), { uv: false }),
      400,
      "USER_VERIFICATION_REQUIRED",
    );
    const rows = await db
      .select({ id: schema.passkeyTable.id })
      .from(schema.passkeyTable);
    expect(rows).toHaveLength(0);

    const key = new SoftPasskey();
    expect((await register(app, ivan.cookies, key)).status).toBe(200);
    const { finished } = await signInWithKey(app, "", key, { uv: false });
    expect(sessionCookieSet(finished)).toBe(false);
    await expectError(finished, 401, "USER_VERIFICATION_REQUIRED");
  });

  it("asks a stale session to confirm adding and removing a key; offers the key (R-5)", async () => {
    const { app } = createApp();
    const ivan = await person(app);
    const key = new SoftPasskey();
    const added = await register(app, ivan.cookies, key);
    const { id } = (await added.json()) as { id: string };
    await staleSessions(ivan.userId);

    await expectNotFresh(
      await get(app, "/passkey/generate-register-options", ivan.cookies),
      ["password", "passkey"],
    );
    await expectNotFresh(
      await post(app, "/passkey/delete-passkey", ivan.cookies, { id }),
      ["password", "passkey"],
    );
    expect(await storedCounter(key.credentialId)).toBe(0);
  });

  it("refuses the 11th key and a second session on registration", async () => {
    const { app } = createApp();
    const ivan = await person(app);

    await expectError(
      await register(app, ivan.cookies, new SoftPasskey(), {
        body: { createSession: true },
      }),
      400,
      "PASSKEY_SESSION_NOT_ALLOWED",
    );

    await db.insert(schema.passkeyTable).values(
      Array.from({ length: 10 }, (_, index) => ({
        id: `pk-${index}`,
        publicKey: "x",
        userId: ivan.userId,
        credentialID: `cred-${index}`,
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      })),
    );
    await expectError(
      await get(app, "/passkey/generate-register-options", ivan.cookies),
      400,
      "PASSKEY_LIMIT_REACHED",
    );
  });

  it("refuses a key name over PASSKEY_NAME_MAX on registration and rename (TB-260)", async () => {
    const { app } = createApp();
    const ivan = await person(app);
    const long = "x".repeat(PASSKEY_NAME_MAX + 1);

    await expectError(
      await register(app, ivan.cookies, new SoftPasskey(), {
        body: { name: long },
      }),
      400,
      PASSKEY_ERRORS.nameTooLong,
    );
    expect(await keyNames(ivan.userId)).toEqual([]);

    // The limit counts the trimmed name, as the plugin stores it.
    const fits = "y".repeat(PASSKEY_NAME_MAX);
    const added = await register(app, ivan.cookies, new SoftPasskey(), {
      body: { name: ` ${fits} ` },
    });
    expect(added.status, await added.clone().text()).toBe(200);
    const { id } = (await added.json()) as { id: string };
    expect(await keyNames(ivan.userId)).toEqual([fits]);

    await expectError(
      await post(app, "/passkey/update-passkey", ivan.cookies, {
        id,
        name: long,
      }),
      400,
      PASSKEY_ERRORS.nameTooLong,
    );
    expect(await keyNames(ivan.userId)).toEqual([fits]);

    const renamed = await post(app, "/passkey/update-passkey", ivan.cookies, {
      id,
      name: "z".repeat(PASSKEY_NAME_MAX),
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect(await keyNames(ivan.userId)).toEqual(["z".repeat(PASSKEY_NAME_MAX)]);
  });

  it("confirms a stale session with the same user's key and replaces it (R-5)", async () => {
    const { app } = createApp();
    const ivan = await person(app);
    const key = new SoftPasskey();
    expect((await register(app, ivan.cookies, key)).status).toBe(200);
    const stale = await sessionIdOf(app, ivan.cookies);
    await staleSessions(ivan.userId);
    const before = await countSessions(ivan.userId);
    await expectNotFresh(
      await post(app, "/api-key/create", ivan.cookies, { name: "k" }),
      ["password", "passkey"],
    );

    const { challenge, finished } = await signInWithKey(app, ivan.cookies, key);
    expect(challenge.allowCredentials?.map((item) => item.id)).toEqual([
      key.credentialId,
    ]);
    expect(finished.status, await finished.clone().text()).toBe(200);

    const cookies = withCookies(ivan.cookies, finished);
    expect(await sessionIdOf(app, cookies)).not.toBe(stale);
    expect((await get(app, "/get-session", ivan.cookies)).status).toBe(200);
    expect(
      await (await get(app, "/get-session", ivan.cookies)).json(),
    ).toBeNull();
    expect(await countSessions(ivan.userId)).toBe(before);
    const created = await post(app, "/api-key/create", cookies, { name: "k" });
    expect(created.status, await created.clone().text()).toBe(200);
  });

  it("refuses another user's key in the window and keeps the session (R-5)", async () => {
    const { app } = createApp();
    const ivan = await person(app);
    const petr = await person(app);
    const petrKey = new SoftPasskey();
    expect((await register(app, petr.cookies, petrKey)).status).toBe(200);
    await staleSessions(ivan.userId);
    const ivanBefore = await countSessions(ivan.userId);
    const petrBefore = await countSessions(petr.userId);

    const { finished } = await signInWithKey(app, ivan.cookies, petrKey);
    expect(sessionCookieSet(finished)).toBe(false);
    await expectError(finished, 403, "REAUTH_USER_MISMATCH", ["password"]);
    expect(await countSessions(ivan.userId)).toBe(ivanBefore);
    expect(await countSessions(petr.userId)).toBe(petrBefore);
    expect(await failureCount(ivan.userId)).toBe(1);
    expect(await sessionIdOf(app, ivan.cookies)).toBeTruthy();
  });
});
