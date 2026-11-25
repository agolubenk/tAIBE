import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";
import {
  expectError,
  PASSWORD,
  person,
  post,
  staleSessions,
} from "./helpers/reauth";

// TB-31 R-5, slice B: an admin's account-taking actions need a fresh session
// (owner, taibe-d-tb31-scope-1811 = A).
beforeEach(async () => {
  await resetTestDatabase();
});

const ACTIONS = [
  ["/admin/set-user-password", { newPassword: "another horse staple" }],
  ["/admin/impersonate-user", {}],
] as const;

describe("TB-31 R-5: admin actions", () => {
  it("set-user-password and impersonate-user wait for the confirmation", async () => {
    const { app } = createApp();
    const admin = await person(app, "admin");
    const target = await createWorkspaceMember({ role: "member" });
    await staleSessions(admin.userId);

    for (const [path, body] of ACTIONS) {
      await expectError(
        await post(app, path, admin.cookies, {
          userId: target.user.id,
          ...body,
        }),
        403,
        "SESSION_NOT_FRESH",
      );
    }

    const confirmed = await post(app, "/tb/reauth/password", admin.cookies, {
      password: PASSWORD,
    });
    expect(confirmed.status).toBe(200);
    for (const [path, body] of ACTIONS) {
      const done = await post(app, path, admin.cookies, {
        userId: target.user.id,
        ...body,
      });
      expect(done.status, `${path}: ${await done.clone().text()}`).toBe(200);
    }
  });

  it("a non-admin gets the same answer for any target", async () => {
    const { app } = createApp();
    // The first sign-up becomes the instance admin; the caller must not.
    await person(app, "admin");
    const caller = await person(app);
    const target = await createWorkspaceMember({ role: "member" });
    await staleSessions(caller.userId);

    for (const [path, body] of ACTIONS) {
      for (const userId of [target.user.id, randomUUID()]) {
        await expectError(
          await post(app, path, caller.cookies, { userId, ...body }),
          403,
          "SESSION_NOT_FRESH",
        );
      }
    }
  });
});
