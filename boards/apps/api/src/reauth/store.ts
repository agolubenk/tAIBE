import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import {
  REAUTH_CODE_LENGTH,
  REAUTH_CODE_MAX_TRIES,
  REAUTH_CODE_TTL_SECONDS,
  REAUTH_FAILURE_LIMIT,
  REAUTH_FAILURE_WINDOW_SECONDS,
  REAUTH_FRESH_SECONDS,
} from "@kaneo/permissions";
import { and, eq, gt, sql } from "drizzle-orm";
import db, { schema } from "../database";

// TB-31 R-5: the fresh mark, the email code and the failure counter are rows
// of `verification`; no new table in slice A. Each row has one identifier,
// so every write deletes the old row first under an advisory lock.
const table = schema.verificationTable;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const freshId = (sessionId: string) => `tb-reauth:${sessionId}`;
export const codeId = (sessionId: string) => `tb-reauth-code:${sessionId}`;
export const failId = (userId: string) => `tb-reauth-fail:${userId}`;

function lock(tx: Tx, key: string) {
  return tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

async function replaceRow(
  tx: Tx,
  identifier: string,
  value: string,
  ttlSeconds: number,
) {
  await tx.delete(table).where(eq(table.identifier, identifier));
  await tx.insert(table).values({
    identifier,
    value,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  });
}

async function liveRow(tx: Tx | typeof db, identifier: string) {
  const [row] = await tx
    .select({ value: table.value, expiresAt: table.expiresAt })
    .from(table)
    .where(
      and(eq(table.identifier, identifier), gt(table.expiresAt, new Date())),
    )
    .limit(1);
  return row ?? null;
}

// ---- fresh mark ----------------------------------------------------------

export async function markSessionFresh(sessionId: string, userId: string) {
  await db.transaction(async (tx) => {
    await lock(tx, freshId(sessionId));
    await replaceRow(tx, freshId(sessionId), userId, REAUTH_FRESH_SECONDS);
  });
}

export async function isSessionFresh(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const row = await liveRow(db, freshId(sessionId));
  return row?.value === userId;
}

// ---- email code ----------------------------------------------------------

type CodeState = { hash: string; tries: number };

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function parseCode(value: string): CodeState | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as CodeState).hash === "string" &&
      Number.isInteger((parsed as CodeState).tries)
    )
      return parsed as CodeState;
  } catch {
    /* a broken row is no code */
  }
  return null;
}

/** A new 6-digit code for this session; the previous one stops working. */
export async function issueCode(sessionId: string): Promise<string> {
  const code = String(randomInt(0, 10 ** REAUTH_CODE_LENGTH)).padStart(
    REAUTH_CODE_LENGTH,
    "0",
  );
  const state: CodeState = { hash: sha256(code), tries: 0 };
  await db.transaction(async (tx) => {
    await lock(tx, codeId(sessionId));
    await replaceRow(
      tx,
      codeId(sessionId),
      JSON.stringify(state),
      REAUTH_CODE_TTL_SECONDS,
    );
  });
  return code;
}

/**
 * Removes the code only while it is still this one: if a later send-code
 * already replaced it, the later code stays valid.
 */
export async function dropCode(sessionId: string, code: string) {
  await db.transaction(async (tx) => {
    const id = codeId(sessionId);
    await lock(tx, id);
    const row = await liveRow(tx, id);
    if (row && parseCode(row.value)?.hash === sha256(code)) {
      await tx.delete(table).where(eq(table.identifier, id));
    }
  });
}

export type CodeCheck = "ok" | "invalid" | "exhausted" | "expired";

/**
 * "ok" — the code matched and is used up; "invalid" — wrong, tries left;
 * "exhausted" — wrong and that was the last try, the code is gone;
 * "expired" — no live code (expired, used up before, or never sent).
 */
export async function checkCode(
  sessionId: string,
  code: string,
): Promise<CodeCheck> {
  return db.transaction(async (tx) => {
    const id = codeId(sessionId);
    await lock(tx, id);
    const row = await liveRow(tx, id);
    const state = row ? parseCode(row.value) : null;
    if (!row || !state) {
      if (row) await tx.delete(table).where(eq(table.identifier, id));
      return "expired";
    }
    const given = Buffer.from(sha256(code), "hex");
    const stored = Buffer.from(state.hash, "hex");
    if (stored.length === given.length && timingSafeEqual(stored, given)) {
      await tx.delete(table).where(eq(table.identifier, id));
      return "ok";
    }
    const tries = state.tries + 1;
    if (tries >= REAUTH_CODE_MAX_TRIES) {
      await tx.delete(table).where(eq(table.identifier, id));
      return "exhausted";
    }
    await tx
      .update(table)
      .set({
        value: JSON.stringify({ ...state, tries }),
        updatedAt: new Date(),
      })
      .where(eq(table.identifier, id));
    return "invalid";
  });
}

// ---- failure counter per user -------------------------------------------

type FailState = { count: number; windowStart: number };

function parseFail(value: string | undefined): FailState | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      Number.isInteger((parsed as FailState).count) &&
      Number.isFinite((parsed as FailState).windowStart)
    )
      return parsed as FailState;
  } catch {
    /* a broken row counts as none */
  }
  return null;
}

export async function failureCount(userId: string): Promise<number> {
  const row = await liveRow(db, failId(userId));
  return parseFail(row?.value)?.count ?? 0;
}

export function isLockedOut(count: number): boolean {
  return count >= REAUTH_FAILURE_LIMIT;
}

/** One more failed confirmation; returns the count in the current hour. */
export async function recordFailure(userId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const id = failId(userId);
    await lock(tx, id);
    const now = Date.now();
    const row = await liveRow(tx, id);
    const state = parseFail(row?.value);
    const inWindow =
      state && now - state.windowStart < REAUTH_FAILURE_WINDOW_SECONDS * 1000;
    const next: FailState = inWindow
      ? { count: state.count + 1, windowStart: state.windowStart }
      : { count: 1, windowStart: now };
    const ttl = Math.ceil(
      (next.windowStart + REAUTH_FAILURE_WINDOW_SECONDS * 1000 - now) / 1000,
    );
    await replaceRow(tx, id, JSON.stringify(next), Math.max(ttl, 1));
    return next.count;
  });
}

export async function resetFailures(userId: string) {
  await db.delete(table).where(eq(table.identifier, failId(userId)));
}
