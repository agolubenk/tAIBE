import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../../apps/api/src/index";
import {
  REAUTH_SEND_CODE_LIMIT,
  REAUTH_SEND_CODE_WINDOW_SECONDS,
} from "../../packages/permissions/src";
import { releaseSend, reserveSend } from "../../apps/api/src/reauth/store";
import { resetTestDatabase } from "./helpers/database";
import { type App, person } from "./helpers/reauth";

// TB-244: code emails per user per hour, whatever the IP. The sender is
// mocked, so no mail leaves the test.
const mail = vi.hoisted(() => ({
  send: vi.fn(async () => ({ success: true })),
}));
vi.mock("@kaneo/email", async (original) => ({
  ...(await original<object>()),
  isSmtpConfigured: () => true,
  sendReauthCodeEmail: mail.send,
}));

let ip = 0;
function sendCode(app: App, cookies: string) {
  ip += 1;
  return app.request("/api/auth/tb/reauth/send-code", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookies,
      "x-forwarded-for": `198.51.100.${ip % 250}`,
    },
    body: "{}",
  });
}

async function expectLimited(response: Response) {
  expect(response.status).toBe(429);
  const wait = Number(response.headers.get("Retry-After"));
  expect(wait).toBeGreaterThan(REAUTH_SEND_CODE_WINDOW_SECONDS - 60);
  expect(wait).toBeLessThanOrEqual(REAUTH_SEND_CODE_WINDOW_SECONDS);
  expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
}

beforeEach(async () => {
  await resetTestDatabase();
  mail.send.mockReset();
  mail.send.mockImplementation(async () => ({ success: true }));
});

describe("TB-244: code emails per user", () => {
  it("sends the hour's codes from different IPs, then 429; another user is not touched", async () => {
    const { app } = createApp();
    const one = await person(app);
    const other = await person(app);
    for (let i = 0; i < REAUTH_SEND_CODE_LIMIT; i += 1) {
      expect((await sendCode(app, one.cookies)).status).toBe(200);
    }
    await expectLimited(await sendCode(app, one.cookies));
    expect(mail.send).toHaveBeenCalledTimes(REAUTH_SEND_CODE_LIMIT);

    expect((await sendCode(app, other.cookies)).status).toBe(200);
  });

  it("lets exactly the limit through a burst of parallel requests", async () => {
    const { app } = createApp();
    const { cookies } = await person(app);
    const burst = await Promise.all(
      Array.from({ length: REAUTH_SEND_CODE_LIMIT * 2 }, () =>
        sendCode(app, cookies),
      ),
    );
    const statuses = burst.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(
      REAUTH_SEND_CODE_LIMIT,
    );
    expect(statuses.filter((status) => status === 429)).toHaveLength(
      REAUTH_SEND_CODE_LIMIT,
    );
    expect(mail.send).toHaveBeenCalledTimes(REAUTH_SEND_CODE_LIMIT);
  });

  it("gives back the place of a code that was not sent", async () => {
    const { app } = createApp();
    const { cookies } = await person(app);
    mail.send.mockImplementationOnce(async () => ({ success: false }));
    expect((await sendCode(app, cookies)).status).toBe(502);
    for (let i = 0; i < REAUTH_SEND_CODE_LIMIT; i += 1) {
      expect((await sendCode(app, cookies)).status).toBe(200);
    }
    await expectLimited(await sendCode(app, cookies));
  });

  it("does not add a place for a give-back with nothing taken", async () => {
    const { app } = createApp();
    const { userId } = await person(app);
    expect(await reserveSend(userId)).toBeNull();
    await releaseSend(userId);
    await releaseSend(userId);
    for (let i = 0; i < REAUTH_SEND_CODE_LIMIT; i += 1) {
      expect(await reserveSend(userId)).toBeNull();
    }
    expect(await reserveSend(userId)).toBeGreaterThan(0);
  });
});
