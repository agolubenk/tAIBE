import { describe, expect, it, vi } from "vite-plus/test";
import type { GuardSession } from "../reauth/guard";
import {
  assertUsernameRequest,
  setsLogin,
  USERNAME_PLUGIN_OPTIONS,
} from "./username-login";

const request = new Request("http://localhost/api/auth/x", { method: "POST" });
const signedIn: GuardSession = {
  session: { id: "s1" },
  user: { id: "u1" },
};

function call(path: string, body: unknown, session = signedIn) {
  const resolve = vi.fn(async () => session);
  return {
    resolve,
    run: assertUsernameRequest({ path, body, request }, resolve),
  };
}

describe("TB-31 R-1: username plugin options", () => {
  it("refuses a reserved login in any case before normalization", () => {
    expect(USERNAME_PLUGIN_OPTIONS.usernameValidator("Admin")).toBe(false);
    expect(USERNAME_PLUGIN_OPTIONS.displayUsernameValidator("ROOT")).toBe(
      false,
    );
    expect(USERNAME_PLUGIN_OPTIONS.usernameValidator("Ivan42")).toBe(true);
  });

  it("refuses dots and underscores the plugin's default rule allows", () => {
    expect(USERNAME_PLUGIN_OPTIONS.usernameValidator("ivan.k")).toBe(false);
    expect(USERNAME_PLUGIN_OPTIONS.usernameValidator("ivan_k")).toBe(false);
  });
});

describe("TB-31 R-1: setsLogin", () => {
  it("sees either login field, even empty", () => {
    expect(setsLogin({ username: "a" })).toBe(true);
    expect(setsLogin({ displayUsername: "a" })).toBe(true);
    expect(setsLogin({ username: undefined })).toBe(true);
    expect(setsLogin({ name: "Ivan" })).toBe(false);
    expect(setsLogin(null)).toBe(false);
  });
});

describe("TB-31 R-1: assertUsernameRequest", () => {
  it("answers /is-username-available only with a session", async () => {
    await expect(
      call("/is-username-available", { username: "ivan" }).run,
    ).resolves.toBeUndefined();
    await expect(
      assertUsernameRequest(
        { path: "/is-username-available", body: {}, request },
        async () => null,
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("lets a server-side call through without a lookup", async () => {
    const resolve = vi.fn(async () => null);
    await assertUsernameRequest(
      { path: "/is-username-available", body: {} },
      resolve,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("takes the login on /update-user only as a pair", async () => {
    await expect(
      call("/update-user", { username: "Ivan42", displayUsername: "Ivan42" })
        .run,
    ).resolves.toBeUndefined();
    await expect(
      call("/update-user", { username: "ivan42", displayUsername: "IVAN42" })
        .run,
    ).resolves.toBeUndefined();
    for (const body of [
      { username: "ivan42" },
      { displayUsername: "Ivan42" },
      { username: "ivan42", displayUsername: "petr42" },
      { username: null, displayUsername: null },
      { username: 42, displayUsername: 42 },
    ]) {
      await expect(
        call("/update-user", body).run,
        JSON.stringify(body),
      ).rejects.toMatchObject({
        statusCode: 400,
        body: expect.objectContaining({ code: "INVALID_DISPLAY_USERNAME" }),
      });
    }
  });

  it("leaves other /update-user bodies to the endpoint", async () => {
    await expect(
      call("/update-user", { name: "Ivan" }).run,
    ).resolves.toBeUndefined();
  });

  it("lets sign-up send one field and checks a pair", async () => {
    await expect(
      call("/sign-up/email", { username: "ivan42" }).run,
    ).resolves.toBeUndefined();
    await expect(
      call("/sign-up/email", { displayUsername: "Ivan42" }).run,
    ).resolves.toBeUndefined();
    await expect(
      call("/sign-up/email", { username: "ivan42", displayUsername: "petr" })
        .run,
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
