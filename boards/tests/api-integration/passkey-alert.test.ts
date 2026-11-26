import { randomUUID } from "node:crypto";
import {
  PASSKEY_ALERT_PAGE,
  PASSKEY_ERRORS,
} from "../../packages/permissions/src";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { agentProfileTable } from "../../apps/api/src/database/forest-schema";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import { register } from "./helpers/passkey-flow";
import {
  type App,
  countSessions,
  expectError,
  person,
  post,
} from "./helpers/reauth";
import { SoftPasskey } from "./helpers/soft-passkey";

// TB-31 R-6: the «A passkey was added» email and its «This wasn't me» link.
// Spec: docs/impl/impl-tb119-profile-login.md, R-6.
const mail = vi.hoisted(() => ({
  send: vi.fn(async (..._args: unknown[]) => ({ success: true })),
}));
vi.mock("@kaneo/email", async (original) => ({
  ...(await original<object>()),
  sendPasskeyAddedEmail: mail.send,
}));

beforeEach(async () => {
  await resetTestDatabase();
  mail.send.mockReset();
  mail.send.mockResolvedValue({ success: true });
});

const HOUR = 60 * 60 * 1000;

/** The token of the last «A passkey was added» email. */
function lastToken(): string {
  const data = mail.send.mock.calls.at(-1)?.[2] as { alertLink: string };
  const [page, token] = data.alertLink.split("#t=");
  expect(page?.endsWith(PASSKEY_ALERT_PAGE)).toBe(true);
  return token ?? "";
}

async function addKey(app: App) {
  const ivan = await person(app);
  const added = await register(app, ivan.cookies, new SoftPasskey());
  expect(added.status, await added.clone().text()).toBe(200);
  const key = (await added.json()) as { id: string; createdAt: string };
  return { ivan, keyId: key.id, addedAt: new Date(key.createdAt) };
}

async function apiKey(referenceId: string, createdAt: Date) {
  const [row] = await db
    .insert(schema.apikeyTable)
    .values({
      referenceId,
      key: randomUUID(),
      createdAt,
      updatedAt: createdAt,
    })
    .returning({ id: schema.apikeyTable.id });
  return row?.id ?? "";
}

async function apiKeysLeft(ids: string[]) {
  const rows = await db
    .select({ id: schema.apikeyTable.id })
    .from(schema.apikeyTable);
  return ids.filter((id) => rows.some((row) => row.id === id));
}

async function keyExists(keyId: string) {
  const rows = await db
    .select({ id: schema.passkeyTable.id })
    .from(schema.passkeyTable)
    .where(eq(schema.passkeyTable.id, keyId));
  return rows.length === 1;
}

const alertRows = (keyId: string) =>
  db
    .select({ id: schema.verificationTable.id })
    .from(schema.verificationTable)
    .where(
      eq(schema.verificationTable.identifier, `tb-passkey-alert:${keyId}`),
    );

describe("TB-31 R-6: «This wasn't me» after a passkey was added", () => {
  it("emails the account; inspect changes nothing; confirm removes the key, later API keys and every session, once", async () => {
    const { app } = createApp();
    const { ivan, keyId, addedAt } = await addKey(app);
    expect(mail.send).toHaveBeenCalledTimes(1);
    const [to, subject] = mail.send.mock.calls[0] as [string, string];
    expect(to).toMatch(/@example\.com$/);
    expect(subject).toContain("Laptop");
    const token = lastToken();
    expect(await alertRows(keyId)).toHaveLength(1);

    const agent = await person(app);
    await db.insert(agentProfileTable).values({
      userId: agent.userId,
      ownerId: ivan.userId,
      harness: "claude-code",
      session: "test",
    });
    const before = await apiKey(
      ivan.userId,
      new Date(addedAt.getTime() - HOUR),
    );
    const agentBefore = await apiKey(
      agent.userId,
      new Date(addedAt.getTime() - HOUR),
    );
    const after = await apiKey(ivan.userId, new Date(addedAt.getTime() + 1000));
    const agentAfter = await apiKey(
      agent.userId,
      new Date(addedAt.getTime() + 1000),
    );
    const sessions = await countSessions(ivan.userId);
    expect(sessions).toBeGreaterThan(0);

    const shown = await post(app, "/tb/passkey-alert/inspect", "", { token });
    expect(shown.status, await shown.clone().text()).toBe(200);
    expect(await shown.json()).toEqual({
      keyName: "Laptop",
      addedAt: addedAt.toISOString(),
      keyExists: true,
    });
    expect(await keyExists(keyId)).toBe(true);
    expect(await countSessions(ivan.userId)).toBe(sessions);

    const done = await post(app, "/tb/passkey-alert/confirm", "", { token });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await done.json()).toEqual({ status: true });
    expect(await keyExists(keyId)).toBe(false);
    expect(await apiKeysLeft([before, agentBefore, after, agentAfter])).toEqual(
      [before, agentBefore],
    );
    expect(await countSessions(ivan.userId)).toBe(0);
    expect(await countSessions(agent.userId)).toBeGreaterThan(0);
    expect(await alertRows(keyId)).toHaveLength(0);

    for (const path of [
      "/tb/passkey-alert/confirm",
      "/tb/passkey-alert/inspect",
    ])
      await expectError(
        await post(app, path, "", { token }),
        400,
        PASSKEY_ERRORS.alertInvalid,
      );
  });

  it("shows a key the person removed already, and confirm still signs out", async () => {
    const { app } = createApp();
    const { ivan, keyId } = await addKey(app);
    const token = lastToken();
    await db
      .delete(schema.passkeyTable)
      .where(eq(schema.passkeyTable.id, keyId));

    const shown = await post(app, "/tb/passkey-alert/inspect", "", { token });
    expect(await shown.json()).toMatchObject({
      keyName: "Laptop",
      keyExists: false,
    });
    const done = await post(app, "/tb/passkey-alert/confirm", "", { token });
    expect(done.status).toBe(200);
    expect(await countSessions(ivan.userId)).toBe(0);
  });

  it("shows the name from the email after the key is renamed (TB-260)", async () => {
    const { app } = createApp();
    const { ivan, keyId } = await addKey(app);
    const token = lastToken();
    const renamed = await post(app, "/passkey/update-passkey", ivan.cookies, {
      id: keyId,
      name: "iPhone — это вы",
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);

    const shown = await post(app, "/tb/passkey-alert/inspect", "", { token });
    expect(await shown.json()).toMatchObject({
      keyName: "Laptop",
      keyExists: true,
    });
  });

  it("refuses a wrong secret, a broken token and an expired link the same way, and changes nothing", async () => {
    const { app } = createApp();
    const { ivan, keyId } = await addKey(app);
    const token = lastToken();
    const [rowId] = token.split(".");
    const sessions = await countSessions(ivan.userId);
    const wrong = `${rowId}.${"A".repeat(43)}`;

    for (const bad of [wrong, `${rowId}.short`, "", `x${token}`])
      for (const path of [
        "/tb/passkey-alert/inspect",
        "/tb/passkey-alert/confirm",
      ])
        await expectError(
          await post(app, path, "", { token: bad }),
          400,
          PASSKEY_ERRORS.alertInvalid,
        );

    await db
      .update(schema.verificationTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        eq(schema.verificationTable.identifier, `tb-passkey-alert:${keyId}`),
      );
    await expectError(
      await post(app, "/tb/passkey-alert/confirm", "", { token }),
      400,
      PASSKEY_ERRORS.alertInvalid,
    );
    expect(await keyExists(keyId)).toBe(true);
    expect(await countSessions(ivan.userId)).toBe(sessions);
  });

  it("adds the key when the email fails (no SMTP or a send error)", async () => {
    const { app } = createApp();
    mail.send.mockRejectedValue(new Error("smtp down"));
    const { keyId } = await addKey(app);
    expect(await keyExists(keyId)).toBe(true);
    expect(await alertRows(keyId)).toHaveLength(1);
  });
});
