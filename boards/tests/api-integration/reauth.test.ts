import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, like } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import {
  checkCode,
  dropCode,
  issueCode,
} from "../../apps/api/src/reauth/store";
import { collectCookies } from "./helpers/auth-session";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";
import {
  ageSessions,
  countSessions,
  expectError,
  expectNotFresh,
  get,
  PASSWORD,
  person,
  post,
  sessionIdOf,
  staleSessions,
  userExists,
} from "./helpers/reauth";

// TB-31 R-5, slice A. The email code needs SMTP; the switch and the sender
// are mocked, so no mail leaves the test.
const mail = vi.hoisted(() => ({
  smtp: false,
  send: vi.fn(async () => ({ success: true })),
}));
vi.mock("@kaneo/email", async (original) => ({
  ...(await original<object>()),
  isSmtpConfigured: () => mail.smtp,
  sendReauthCodeEmail: mail.send,
}));

async function failRow(userId: string) {
  const [row] = await db
    .select({ value: schema.verificationTable.value })
    .from(schema.verificationTable)
    .where(eq(schema.verificationTable.identifier, `tb-reauth-fail:${userId}`));
  return row ? (JSON.parse(row.value) as { count: number }) : null;
}

function lastCode() {
  const call = mail.send.mock.calls.at(-1) as unknown as
    | [string, string, { code: string }]
    | undefined;
  if (!call) throw new Error("no code was sent");
  return call[2].code;
}

beforeEach(async () => {
  await resetTestDatabase();
  mail.smtp = false;
  mail.send.mockReset();
  mail.send.mockImplementation(async () => ({ success: true }));
});

describe("TB-31 R-5: fresh session", () => {
  it("an interactive sign-in starts fresh; a sign-up does not", async () => {
    const { app } = createApp();
    const signedIn = await person(app);
    expect((await get(app, "/list-sessions", signedIn.cookies)).status).toBe(
      200,
    );

    const response = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `${randomUUID()}@example.com`,
        password: PASSWORD,
        name: "New",
      }),
    });
    expect(response.status).toBe(200);
    const cookies = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    await expectNotFresh(await get(app, "/list-sessions", cookies), [
      "password",
    ]);
  });

  // plan 02:22, condition 1.
  it("a session older than 24 h with a live mark deletes the account without a password", async () => {
    const { app } = createApp();
    const { userId, cookies } = await person(app);
    await ageSessions(userId, 25);

    const response = await post(app, "/delete-user", cookies, {});
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await userExists(userId)).toBe(false);
  });

  // plan 02:22, condition 1.
  it("no mark: list-sessions and unlink-account give 403 SESSION_NOT_FRESH", async () => {
    const { app } = createApp();
    const { userId, cookies } = await person(app);
    await staleSessions(userId);

    await expectNotFresh(await get(app, "/list-sessions", cookies), [
      "password",
    ]);
    await expectNotFresh(
      await post(app, "/unlink-account", cookies, { providerId: "github" }),
      ["password"],
    );
  });

  it("guards api-key/create and delete-user until the password confirms it", async () => {
    const { app } = createApp();
    const { userId, cookies } = await person(app);
    await staleSessions(userId);

    await expectNotFresh(
      await post(app, "/api-key/create", cookies, { name: "Script" }),
      ["password"],
    );
    await expectNotFresh(await post(app, "/delete-user", cookies), [
      "password",
    ]);
    expect(await userExists(userId)).toBe(true);

    const before = await countSessions(userId);
    const confirmed = await post(app, "/tb/reauth/password", cookies, {
      password: PASSWORD,
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ status: true });
    // No new session and no new cookie.
    expect(confirmed.headers.getSetCookie()).toEqual([]);
    expect(await countSessions(userId)).toBe(before);
  });

  it("the mark opens the guarded action, then expires", async () => {
    const { app } = createApp();
    const { userId, cookies } = await person(app);
    await staleSessions(userId);
    const sessionId = await sessionIdOf(app, cookies);
    await post(app, "/tb/reauth/password", cookies, { password: PASSWORD });

    const created = await post(app, "/api-key/create", cookies, {
      name: "Script",
    });
    expect(created.status).toBe(200);

    await db
      .update(schema.verificationTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.verificationTable.identifier, `tb-reauth:${sessionId}`));
    await expectNotFresh(
      await post(app, "/api-key/create", cookies, { name: "Second" }),
      ["password"],
    );
  });

  it("guards an admin email change, but not a same-email edit", async () => {
    const { app } = createApp();
    const admin = await person(app, "admin");
    const target = await createWorkspaceMember({ role: "member" });
    await staleSessions(admin.userId);

    const [current] = await db
      .select({ email: schema.userTable.email })
      .from(schema.userTable)
      .where(eq(schema.userTable.id, target.user.id));
    const sameEmail = await post(app, "/admin/update-user", admin.cookies, {
      userId: target.user.id,
      // better-auth refuses spaces; case alone must not count as a change.
      data: { email: current?.email.toUpperCase(), name: "Renamed" },
    });
    expect(sameEmail.status, await sameEmail.clone().text()).toBe(200);

    await expectNotFresh(
      await post(app, "/admin/update-user", admin.cookies, {
        userId: target.user.id,
        data: { email: "renamed@example.com" },
      }),
      ["password"],
    );
  });

  it("tells a non-admin nothing about the target's email (release N14)", async () => {
    const { app } = createApp();
    // The first sign-up becomes the instance admin; the caller must not.
    await person(app, "admin");
    const caller = await person(app);
    const target = await createWorkspaceMember({ role: "member" });
    await staleSessions(caller.userId);
    const [current] = await db
      .select({ email: schema.userTable.email })
      .from(schema.userTable)
      .where(eq(schema.userTable.id, target.user.id));

    // The same answer for the user's own email, another one and no user.
    for (const [userId, email] of [
      [target.user.id, current?.email],
      [target.user.id, "renamed@example.com"],
      [randomUUID(), "renamed@example.com"],
    ]) {
      await expectNotFresh(
        await post(app, "/admin/update-user", caller.cookies, {
          userId,
          data: { email },
        }),
        ["password"],
      );
    }
  });
});

describe("TB-31 R-5: password confirmation", () => {
  it("a wrong password counts; 10 in an hour take the password away", async () => {
    const { app } = createApp();
    const { userId, cookies } = await person(app);
    await staleSessions(userId);

    for (let i = 1; i <= 9; i++) {
      await expectError(
        await post(app, "/tb/reauth/password", cookies, { password: "nope" }),
        400,
        "INVALID_PASSWORD",
        ["password"],
      );
    }
    await expectError(
      await post(app, "/tb/reauth/password", cookies, { password: "nope" }),
      400,
      "INVALID_PASSWORD",
      [],
    );
    expect((await failRow(userId))?.count).toBe(10);
    // Even the right password is not taken now.
    await expectError(
      await post(app, "/tb/reauth/password", cookies, { password: PASSWORD }),
      400,
      "METHOD_UNAVAILABLE",
      [],
    );
    await expectNotFresh(await get(app, "/list-sessions", cookies), []);
  });

  it("a success resets the failure counter", async () => {
    const { app } = createApp();
    const { userId, cookies } = await person(app);
    for (let i = 0; i < 3; i++) {
      await post(app, "/tb/reauth/password", cookies, { password: "nope" });
    }
    expect((await failRow(userId))?.count).toBe(3);
    await post(app, "/tb/reauth/password", cookies, { password: PASSWORD });
    expect(await failRow(userId)).toBeNull();
  });

  it("no session gets 401", async () => {
    const { app } = createApp();
    const response = await post(app, "/tb/reauth/password", "", {
      password: PASSWORD,
    });
    expect(response.status).toBe(401);
  });
});

describe("TB-31 R-5: email code", () => {
  it("is offered only with SMTP and confirms the session", async () => {
    const { app } = createApp();
    const { userId, cookies } = await person(app);
    await staleSessions(userId);
    await expectError(
      await post(app, "/tb/reauth/send-code", cookies),
      400,
      "METHOD_UNAVAILABLE",
      ["password"],
    );

    mail.smtp = true;
    await expectNotFresh(await get(app, "/list-sessions", cookies), [
      "password",
      "emailCode",
    ]);
    expect((await post(app, "/tb/reauth/send-code", cookies)).status).toBe(200);
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(mail.send.mock.calls.at(-1)?.[0]).toContain("@example.com");

    const wrong = code === "000000" ? "111111" : "000000";
    await expectError(
      await post(app, "/tb/reauth/verify-code", cookies, { code: wrong }),
      400,
      "INVALID_CODE",
      ["password", "emailCode"],
    );
    await expectError(
      await post(app, "/tb/reauth/verify-code", cookies, { code: "12ab" }),
      400,
      "INVALID_CODE",
    );
    const ok = await post(app, "/tb/reauth/verify-code", cookies, { code });
    expect(ok.status).toBe(200);
    expect((await get(app, "/list-sessions", cookies)).status).toBe(200);
    // The code works once.
    await expectError(
      await post(app, "/tb/reauth/verify-code", cookies, { code }),
      400,
      "CODE_EXPIRED",
    );
  });

  it("the 5th wrong try ends the code; a new code ends the old one", async () => {
    mail.smtp = true;
    const { app } = createApp();
    const { userId, cookies } = await person(app);
    await post(app, "/tb/reauth/send-code", cookies);
    const first = lastCode();
    await post(app, "/tb/reauth/send-code", cookies);
    const second = lastCode();
    if (first !== second) {
      await expectError(
        await post(app, "/tb/reauth/verify-code", cookies, { code: first }),
        400,
        "INVALID_CODE",
      );
    }

    const wrong = second === "000000" ? "111111" : "000000";
    const tries = first !== second ? 3 : 4;
    for (let i = 0; i < tries; i++) {
      await expectError(
        await post(app, "/tb/reauth/verify-code", cookies, { code: wrong }),
        400,
        "INVALID_CODE",
      );
    }
    await expectError(
      await post(app, "/tb/reauth/verify-code", cookies, { code: wrong }),
      400,
      "CODE_EXPIRED",
    );
    await expectError(
      await post(app, "/tb/reauth/verify-code", cookies, { code: second }),
      400,
      "CODE_EXPIRED",
    );
    expect((await failRow(userId))?.count).toBe(5);
  });

  it("a failed delivery gives 502 and leaves no code", async () => {
    mail.smtp = true;
    mail.send.mockImplementation(async () => {
      throw new Error("smtp down");
    });
    const { app } = createApp();
    const { cookies } = await person(app);
    await expectError(
      await post(app, "/tb/reauth/send-code", cookies),
      502,
      "EMAIL_DELIVERY_FAILED",
    );
    const codes = await db
      .select({ id: schema.verificationTable.id })
      .from(schema.verificationTable)
      .where(like(schema.verificationTable.identifier, "tb-reauth-code:%"));
    expect(codes).toEqual([]);
  });
});

describe("TB-31 R-5: impersonation and keys", () => {
  it("an impersonated session gets no method and cannot confirm", async () => {
    const { app } = createApp();
    const admin = await person(app, "admin");
    const target = await person(app);
    const started = await post(app, "/admin/impersonate-user", admin.cookies, {
      userId: target.userId,
    });
    expect(started.status, await started.clone().text()).toBe(200);
    const cookies = collectCookies(started);

    const refused = await get(app, "/list-sessions", cookies);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: "SESSION_NOT_FRESH",
      methods: [],
      impersonated: true,
    });
    await expectError(
      await post(app, "/tb/reauth/password", cookies, { password: PASSWORD }),
      403,
      "IMPERSONATION_NOT_ALLOWED",
    );
    // The impersonation session got no mark at creation.
    const [impersonation] = await db
      .select({ id: schema.sessionTable.id })
      .from(schema.sessionTable)
      .where(
        and(
          eq(schema.sessionTable.userId, target.userId),
          isNotNull(schema.sessionTable.impersonatedBy),
        ),
      );
    expect(impersonation).toBeDefined();
    const marks = await db
      .select({ id: schema.verificationTable.id })
      .from(schema.verificationTable)
      .where(
        eq(
          schema.verificationTable.identifier,
          `tb-reauth:${impersonation?.id}`,
        ),
      );
    expect(marks).toEqual([]);
  });

  // AC-12: an API key never reaches the reauth routes.
  it("refuses /tb/reauth/* to an API key", async () => {
    const { app } = createApp();
    const { cookies } = await person(app);
    const created = await post(app, "/api-key/create", cookies, {
      name: "Script",
    });
    expect(created.status).toBe(200);
    const { key } = (await created.json()) as { key: string };

    const response = await app.request("/api/auth/tb/reauth/password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "SESSION_REQUIRED",
    });
  });
});

describe("TB-31 R-5: a failed send drops only its own code", () => {
  it("keeps a later code when an earlier send fails after it", async () => {
    const sessionId = randomUUID();
    const first = await issueCode(sessionId);
    const second = await issueCode(sessionId);
    await dropCode(sessionId, first);
    expect(await checkCode(sessionId, second)).toBe("ok");
  });

  it("drops the code when it is still the current one", async () => {
    const sessionId = randomUUID();
    const code = await issueCode(sessionId);
    await dropCode(sessionId, code);
    expect(await checkCode(sessionId, code)).toBe("expired");
  });
});
