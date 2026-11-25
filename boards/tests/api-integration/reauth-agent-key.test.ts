import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../../apps/api/src/index";
import { collectCookies } from "./helpers/auth-session";
import { resetTestDatabase } from "./helpers/database";
import {
  type App,
  expectError,
  expectNotFresh,
  PASSWORD,
  person,
  post,
  staleSessions,
} from "./helpers/reauth";

// TB-31 R-5, owner taibe-d-tb31-agent-key-1811 = A: a browser session issues
// agent keys only when fresh; a device-flow session does without asking; the
// device approval itself is under the guard.
beforeEach(async () => {
  await resetTestDatabase();
});

const BODY = { harness: "claude-code", session: "reauth test" };

function issueKey(app: App, headers: Record<string, string>) {
  return app.request("/api/agent-identity/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(BODY),
  });
}

function device(app: App, path: string, body: unknown) {
  return app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deviceCode(app: App) {
  const res = await device(app, "/device/code", { client_id: "kaneo-cli" });
  expect(res.status).toBe(200);
  return (await res.json()) as { device_code: string; user_code: string };
}

async function claim(app: App, cookies: string, userCode: string) {
  const res = await app.request(
    `/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
    { headers: { cookie: cookies } },
  );
  expect(res.status).toBe(200);
}

describe("TB-31 R-5: agent keys and the device flow", () => {
  it("a stale browser session confirms before it issues a key", async () => {
    const { app } = createApp();
    const owner = await person(app);
    await staleSessions(owner.userId);

    await expectNotFresh(await issueKey(app, { cookie: owner.cookies }), [
      "password",
    ]);

    const confirmed = await post(app, "/tb/reauth/password", owner.cookies, {
      password: PASSWORD,
    });
    expect(confirmed.status).toBe(200);
    const issued = await issueKey(app, { cookie: owner.cookies });
    expect(issued.status, await issued.clone().text()).toBe(200);
  });

  it("the approval waits for a fresh sign-in; the device session then issues keys", async () => {
    const { app } = createApp();
    const owner = await person(app);
    await staleSessions(owner.userId);
    const codes = await deviceCode(app);
    await claim(app, owner.cookies, codes.user_code);

    const approve = { userCode: codes.user_code };
    await expectNotFresh(
      await post(app, "/device/approve", owner.cookies, approve),
      ["password"],
    );
    expect(
      (
        await post(app, "/tb/reauth/password", owner.cookies, {
          password: PASSWORD,
        })
      ).status,
    ).toBe(200);
    expect(
      (await post(app, "/device/approve", owner.cookies, approve)).status,
    ).toBe(200);

    const token = await device(app, "/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: codes.device_code,
      client_id: "kaneo-cli",
    });
    expect(token.status).toBe(200);
    const { access_token } = (await token.json()) as { access_token: string };

    // The device session never had a fresh mark, and needs none.
    await staleSessions(owner.userId);
    const issued = await issueKey(app, {
      authorization: `Bearer ${access_token}`,
    });
    expect(issued.status, await issued.clone().text()).toBe(200);
  });

  it("an impersonated session never issues a key", async () => {
    const { app } = createApp();
    const admin = await person(app, "admin");
    const target = await person(app);
    const impersonated = await post(
      app,
      "/admin/impersonate-user",
      admin.cookies,
      { userId: target.userId },
    );
    expect(impersonated.status).toBe(200);

    const refused = await issueKey(app, {
      cookie: collectCookies(impersonated),
    });
    await expectError(refused.clone(), 403, "SESSION_NOT_FRESH", []);
    expect(await refused.json()).toMatchObject({ impersonated: true });
  });
});
