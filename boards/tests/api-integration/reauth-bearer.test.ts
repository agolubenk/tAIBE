import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { auth } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";
import {
  expectNotFresh,
  PASSWORD,
  person,
  post,
  sessionIdOf,
  staleSessions,
  tokenOf,
  userExists,
  viaBearer,
} from "./helpers/reauth";

beforeEach(async () => {
  await resetTestDatabase();
});

// Claude lens on #476: the guard runs in the user hook, before the bearer
// plugin turns the token into the session cookie (B1); better-auth coerces
// the admin userId to a string (B2).
describe("TB-31 R-5: Bearer and loose bodies", () => {
  it("a Bearer session without a mark is guarded on all five routes", async () => {
    const { app } = createApp();
    const admin = await person(app, "admin");
    const target = await createWorkspaceMember({ role: "member" });
    const token = await tokenOf(await sessionIdOf(app, admin.cookies));
    await staleSessions(admin.userId);

    await expectNotFresh(await viaBearer(app, token, "/list-sessions"), [
      "password",
    ]);
    for (const [path, body] of [
      ["/unlink-account", { providerId: "github" }],
      ["/api-key/create", { name: "Script" }],
      ["/delete-user", {}],
      [
        "/admin/update-user",
        { userId: target.user.id, data: { email: "moved@example.com" } },
      ],
    ] as const) {
      await expectNotFresh(await viaBearer(app, token, path, body), [
        "password",
      ]);
    }
    expect(await userExists(admin.userId)).toBe(true);
  });

  it("a Bearer session confirms itself and then passes", async () => {
    const { app } = createApp();
    const { userId, cookies } = await person(app);
    const token = await tokenOf(await sessionIdOf(app, cookies));
    await staleSessions(userId);

    const confirmed = await viaBearer(app, token, "/tb/reauth/password", {
      password: PASSWORD,
    });
    expect(confirmed.status).toBe(200);
    expect((await viaBearer(app, token, "/list-sessions")).status).toBe(200);
  });

  it("checks the Bearer session, not the browser cookie next to it", async () => {
    const { app } = createApp();
    const fresh = await person(app);
    const stale = await person(app);
    const token = await tokenOf(await sessionIdOf(app, stale.cookies));
    await staleSessions(stale.userId);

    // auth.handler directly: index.ts drops the cookie next to a Bearer
    // token, the guard itself must not depend on that.
    const response = await auth.handler(
      new Request("http://localhost:1337/api/auth/list-sessions", {
        headers: { cookie: fresh.cookies, authorization: `Bearer ${token}` },
      }),
    );
    await expectNotFresh(response, ["password"]);
  });

  it("guards an admin userId that is not a string and clears the verification", async () => {
    const { app } = createApp();
    const admin = await person(app, "admin");
    const target = await createWorkspaceMember({ role: "member" });
    await staleSessions(admin.userId);
    const change = {
      userId: [target.user.id],
      data: { email: "moved@example.com" },
    };

    await expectNotFresh(
      await post(app, "/admin/update-user", admin.cookies, change),
      ["password"],
    );
    await post(app, "/tb/reauth/password", admin.cookies, {
      password: PASSWORD,
    });
    const changed = await post(
      app,
      "/admin/update-user",
      admin.cookies,
      change,
    );
    expect(changed.status, await changed.clone().text()).toBe(200);
    const [row] = await db
      .select({
        email: schema.userTable.email,
        emailVerified: schema.userTable.emailVerified,
      })
      .from(schema.userTable)
      .where(eq(schema.userTable.id, target.user.id));
    expect(row).toEqual({ email: "moved@example.com", emailVerified: false });
  });
});
