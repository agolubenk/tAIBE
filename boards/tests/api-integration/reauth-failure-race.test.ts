import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../../apps/api/src/index";
import { failureCount } from "../../apps/api/src/reauth/store";
import { REAUTH_FAILURE_LIMIT } from "../../packages/permissions/src";
import { resetTestDatabase } from "./helpers/database";
import {
  expectError,
  PASSWORD,
  person,
  post,
  staleSessions,
} from "./helpers/reauth";

// No SMTP: the methods left are only "password", so each reply is exact.
vi.mock("@kaneo/email", async (original) => ({
  ...(await original<object>()),
  isSmtpConfigured: () => false,
}));

beforeEach(resetTestDatabase);

const BURST = 2 * REAUTH_FAILURE_LIMIT;

describe("TB-245: the failure limit holds under parallel tries", () => {
  it("a burst of wrong passwords gets at most the limit of checks", async () => {
    const { app } = createApp();
    const { userId, cookies } = await person(app);
    await staleSessions(userId);

    const responses = await Promise.all(
      Array.from({ length: BURST }, () =>
        post(app, "/tb/reauth/password", cookies, { password: "nope" }),
      ),
    );
    const codes = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(400);
        return ((await response.json()) as { code: string }).code;
      }),
    );
    // INVALID_PASSWORD comes only after a password check.
    const checked = codes.filter((code) => code === "INVALID_PASSWORD");
    const closed = codes.filter((code) => code === "METHOD_UNAVAILABLE");
    expect(checked).toHaveLength(REAUTH_FAILURE_LIMIT);
    expect(closed).toHaveLength(BURST - REAUTH_FAILURE_LIMIT);
    expect(await failureCount(userId)).toBe(REAUTH_FAILURE_LIMIT);

    await expectError(
      await post(app, "/tb/reauth/password", cookies, { password: PASSWORD }),
      400,
      "METHOD_UNAVAILABLE",
      [],
    );
  });

  it("the last try under the limit still takes the right password", async () => {
    const { app } = createApp();
    const { userId, cookies } = await person(app);
    for (let i = 1; i < REAUTH_FAILURE_LIMIT; i++) {
      await expectError(
        await post(app, "/tb/reauth/password", cookies, { password: "nope" }),
        400,
        "INVALID_PASSWORD",
        ["password"],
      );
    }
    const response = await post(app, "/tb/reauth/password", cookies, {
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    expect(await failureCount(userId)).toBe(0);
  });
});
