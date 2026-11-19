import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import {
  type App,
  expectError,
  get,
  PASSWORD,
  person,
  post,
  staleSessions,
} from "./helpers/reauth";

// TB-31 R-1: the login. Spec: docs/impl/impl-tb119-profile-login.md, R-1, AC-1…AC-4.
beforeEach(async () => {
  await resetTestDatabase();
});

function setLogin(app: App, cookies: string, login: string) {
  return post(app, "/update-user", cookies, {
    username: login,
    displayUsername: login,
  });
}

function signInWithLogin(app: App, username: string, password = PASSWORD) {
  return app.request("/api/auth/sign-in/username", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

async function storedLogin(userId: string) {
  const [row] = await db
    .select({
      username: schema.userTable.username,
      displayUsername: schema.userTable.displayUsername,
    })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId));
  return row;
}

describe("TB-31 R-1: login", () => {
  it("stores Ivan42 as ivan42, shows Ivan42, signs in with IVAN42 (AC-1)", async () => {
    const { app } = createApp();
    const ivan = await person(app);

    const saved = await setLogin(app, ivan.cookies, "Ivan42");
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await storedLogin(ivan.userId)).toEqual({
      username: "ivan42",
      displayUsername: "Ivan42",
    });

    const signedIn = await signInWithLogin(app, "IVAN42");
    expect(signedIn.status).toBe(200);
    const body = (await signedIn.json()) as { user: { id: string } };
    expect(body.user.id).toBe(ivan.userId);
  });

  it("gives one answer for a wrong login and a wrong password (AC-3)", async () => {
    const { app } = createApp();
    const ivan = await person(app);
    expect((await setLogin(app, ivan.cookies, "ivan42")).status).toBe(200);

    const wrongLogin = await signInWithLogin(app, "petr42");
    const wrongPassword = await signInWithLogin(app, "ivan42", "not it 123");
    expect(wrongLogin.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    const a = (await wrongLogin.json()) as { code: string };
    const b = (await wrongPassword.json()) as { code: string };
    expect(a.code).toBe("INVALID_USERNAME_OR_PASSWORD");
    expect(b.code).toBe(a.code);
  });

  it("asks a stale session to confirm, also for displayUsername alone (AC-4)", async () => {
    const { app } = createApp();
    const ivan = await person(app);
    await staleSessions(ivan.userId);

    await expectError(
      await setLogin(app, ivan.cookies, "ivan42"),
      403,
      "SESSION_NOT_FRESH",
    );
    await expectError(
      await post(app, "/update-user", ivan.cookies, {
        displayUsername: "Ivan42",
      }),
      403,
      "SESSION_NOT_FRESH",
    );
    // The name is not the login: it saves itself without a confirmation.
    const renamed = await post(app, "/update-user", ivan.cookies, {
      name: "Ivan Petrov",
    });
    expect(renamed.status).toBe(200);
    expect(await storedLogin(ivan.userId)).toEqual({
      username: null,
      displayUsername: null,
    });

    const confirmed = await post(app, "/tb/reauth/password", ivan.cookies, {
      password: PASSWORD,
    });
    expect(confirmed.status).toBe(200);
    expect((await setLogin(app, ivan.cookies, "ivan42")).status).toBe(200);
  });

  it("refuses a reserved, a taken and a split login", async () => {
    const { app } = createApp();
    const ivan = await person(app);
    const petr = await person(app);
    expect((await setLogin(app, ivan.cookies, "ivan42")).status).toBe(200);

    await expectError(
      await setLogin(app, petr.cookies, "Admin"),
      400,
      "INVALID_USERNAME",
    );
    await expectError(
      await setLogin(app, petr.cookies, "IVAN42"),
      400,
      "USERNAME_IS_ALREADY_TAKEN",
    );
    await expectError(
      await post(app, "/update-user", petr.cookies, {
        username: "petr42",
        displayUsername: "ivan43",
      }),
      400,
      "INVALID_DISPLAY_USERNAME",
    );
    expect(await storedLogin(petr.userId)).toEqual({
      username: null,
      displayUsername: null,
    });
  });

  it("does not let an admin set a login: no rule and no pair there", async () => {
    const { app } = createApp();
    const admin = await person(app, "admin");
    const ivan = await person(app);
    await expectError(
      await post(app, "/admin/update-user", admin.cookies, {
        userId: ivan.userId,
        data: { username: "root", displayUsername: "ivan43" },
      }),
      400,
      "LOGIN_SET_BY_PERSON",
    );
    expect(await storedLogin(ivan.userId)).toEqual({
      username: null,
      displayUsername: null,
    });
  });

  it("frees the old login at once", async () => {
    const { app } = createApp();
    const ivan = await person(app);
    const petr = await person(app);
    expect((await setLogin(app, ivan.cookies, "ivan42")).status).toBe(200);
    expect((await setLogin(app, ivan.cookies, "ivan43")).status).toBe(200);
    expect((await setLogin(app, petr.cookies, "ivan42")).status).toBe(200);
  });
});

describe("TB-31 R-1: /is-username-available", () => {
  it("answers only a session (AC-3)", async () => {
    const { app } = createApp();
    const ivan = await person(app);

    await expectError(
      await post(app, "/is-username-available", "", { username: "ivan42" }),
      401,
      "UNAUTHORIZED",
    );

    const free = await post(app, "/is-username-available", ivan.cookies, {
      username: "ivan42",
    });
    expect(await free.json()).toEqual({ available: true });
    expect((await setLogin(app, ivan.cookies, "ivan42")).status).toBe(200);
    const taken = await post(app, "/is-username-available", ivan.cookies, {
      username: "IVAN42",
    });
    expect(await taken.json()).toEqual({ available: false });

    const reserved = await post(app, "/is-username-available", ivan.cookies, {
      username: "root",
    });
    expect(reserved.status).toBe(422);
  });

  it("is shown in the session's user", async () => {
    const { app } = createApp();
    const ivan = await person(app);
    expect((await setLogin(app, ivan.cookies, "Ivan42")).status).toBe(200);
    const session = await get(app, "/get-session", ivan.cookies);
    const body = (await session.json()) as {
      user: { username?: string; displayUsername?: string };
    };
    expect(body.user).toMatchObject({
      username: "ivan42",
      displayUsername: "Ivan42",
    });
  });
});
