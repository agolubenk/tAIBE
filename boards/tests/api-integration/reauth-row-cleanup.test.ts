import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  deleteExpiredReauthRows,
  REAUTH_ROW_PREFIX,
} from "../../apps/api/src/reauth/row-cleanup";
import {
  codeId,
  failId,
  freshId,
  isSessionFresh,
  issueCode,
  markSessionFresh,
  recordFailure,
} from "../../apps/api/src/reauth/store";
import { resetTestDatabase } from "./helpers/database";

// TB-246: expired reauth rows are deleted; live and foreign rows stay.
const table = schema.verificationTable;
const past = () => new Date(Date.now() - 60_000);

async function expire(identifiers: string[]) {
  await db
    .update(table)
    .set({ expiresAt: past() })
    .where(inArray(table.identifier, identifiers));
}

async function identifiers() {
  const rows = await db.select({ identifier: table.identifier }).from(table);
  return rows.map((row) => row.identifier).sort();
}

beforeEach(async () => {
  await resetTestDatabase();
});

describe("TB-246: cleanup of expired reauth rows", () => {
  it("every store row kind has the cleanup prefix", () => {
    for (const id of [freshId("s"), codeId("s"), failId("u")]) {
      expect(id.startsWith(REAUTH_ROW_PREFIX)).toBe(true);
    }
  });

  it("deletes expired reauth rows and keeps live and foreign ones", async () => {
    const userId = randomUUID();
    await markSessionFresh("old", userId);
    await issueCode("old");
    await recordFailure(userId);
    await markSessionFresh("live", userId);
    const foreign = [
      `tb-email-change:${userId}`,
      "tb-device:old",
      "tb-passkey-alert:key",
      "reset-password:token",
      "magic-link-token",
    ];
    await db.insert(table).values(
      [`tb-reauth-send:${userId}`, ...foreign].map((identifier) => ({
        identifier,
        value: "{}",
        expiresAt: past(),
      })),
    );
    await expire([freshId("old"), codeId("old"), failId(userId)]);

    expect(await deleteExpiredReauthRows()).toBe(4);
    expect(await identifiers()).toEqual([freshId("live"), ...foreign].sort());
    expect(await isSessionFresh("live", userId)).toBe(true);
  });

  it("goes on past one batch", async () => {
    const total = 1203;
    await db.insert(table).values(
      Array.from({ length: total }, (_, i) => ({
        identifier: `tb-reauth:batch-${i}`,
        value: "u",
        expiresAt: past(),
      })),
    );
    expect(await deleteExpiredReauthRows()).toBe(total);
    expect(await identifiers()).toEqual([]);
  });

  it("does not wait for a row that a reauth write holds", async () => {
    await db.insert(table).values(
      ["tb-reauth-code:held", "tb-reauth-code:free"].map((identifier) => ({
        identifier,
        value: "{}",
        expiresAt: past(),
      })),
    );
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: table.id })
        .from(table)
        .where(eq(table.identifier, "tb-reauth-code:held"))
        .for("update");
      locked();
      await gate;
    });
    await isLocked;

    const run = deleteExpiredReauthRows();
    const first = await Promise.race([
      run,
      new Promise<"waited">((resolve) =>
        setTimeout(() => resolve("waited"), 5_000),
      ),
    ]);
    release();
    await holder;
    await run;

    expect(first).toBe(1);
    expect(await identifiers()).toEqual(["tb-reauth-code:held"]);
    expect(await deleteExpiredReauthRows()).toBe(1);
    expect(await identifiers()).toEqual([]);
  });
});
