import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  PASSKEY_ALERT_TTL_DAYS,
  type PasskeyAlertInspect,
} from "@kaneo/permissions";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import * as z from "zod";
import db, { schema } from "../database";
import { agentProfileTable } from "../database/forest-schema";

// TB-31 R-6: «This wasn't me» in the «A passkey was added» email. One
// `verification` row per key, `tb-passkey-alert:<passkeyId>`; the token is
// `<row id>.<secret>`, the row keeps only sha256 of the secret (as R-4).
const table = schema.verificationTable;
const PREFIX = "tb-passkey-alert:";
const TTL_MS = PASSKEY_ALERT_TTL_DAYS * 24 * 60 * 60 * 1000;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const alertId = (passkeyId: string) => `${PREFIX}${passkeyId}`;

const AlertValue = z.object({
  userId: z.string().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  addedAt: z.iso.datetime(),
  keyName: z.string().nullable(),
});
type AlertValue = z.infer<typeof AlertValue>;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export type AddedPasskey = {
  id: string;
  userId: string;
  name: string | null;
  createdAt: Date;
};

/** Writes the row and returns the token for the email link. */
export async function issuePasskeyAlert(key: AddedPasskey): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  const value: AlertValue = {
    userId: key.userId,
    hash: sha256(secret),
    addedAt: key.createdAt.toISOString(),
    keyName: key.name,
  };
  const [row] = await db
    .insert(table)
    .values({
      identifier: alertId(key.id),
      value: JSON.stringify(value),
      expiresAt: new Date(Date.now() + TTL_MS),
    })
    .returning({ id: table.id });
  if (!row) throw new Error("The passkey alert row was not written.");
  return `${row.id}.${secret}`;
}

// A row id is a cuid2, the secret is 32 bytes in base64url (43 characters).
const TOKEN_RE = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/;

type Found = { rowId: string; passkeyId: string; value: AlertValue };

/**
 * The live alert of the token, or null: a wrong, used or expired link looks
 * the same. `lock` holds the row until the transaction ends (confirm).
 */
async function findAlert(
  tx: Tx | typeof db,
  token: string,
  lock: boolean,
): Promise<Found | null> {
  const match = TOKEN_RE.exec(token);
  if (!match) return null;
  const [, rowId = "", secret = ""] = match;
  const query = tx
    .select({
      identifier: table.identifier,
      value: table.value,
      expiresAt: table.expiresAt,
    })
    .from(table)
    .where(and(eq(table.id, rowId), like(table.identifier, `${PREFIX}%`)))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row || row.expiresAt <= new Date()) return null;
  let value: AlertValue;
  try {
    value = AlertValue.parse(JSON.parse(row.value));
  } catch {
    return null;
  }
  const given = Buffer.from(sha256(secret), "hex");
  const stored = Buffer.from(value.hash, "hex");
  if (given.length !== stored.length || !timingSafeEqual(given, stored))
    return null;
  return { rowId, passkeyId: row.identifier.slice(PREFIX.length), value };
}

/**
 * What the page shows before the person presses the button. No change. The
 * name is the one in the email (TB-260): whoever added the key can rename it
 * without a fresh sign-in, so the current name proves nothing.
 */
export async function inspectPasskeyAlert(
  token: string,
): Promise<PasskeyAlertInspect | null> {
  const found = await findAlert(db, token, false);
  if (!found) return null;
  const [key] = await db
    .select({ id: schema.passkeyTable.id })
    .from(schema.passkeyTable)
    .where(
      and(
        eq(schema.passkeyTable.id, found.passkeyId),
        eq(schema.passkeyTable.userId, found.value.userId),
      ),
    )
    .limit(1);
  return {
    keyName: found.value.keyName,
    addedAt: found.value.addedAt,
    keyExists: Boolean(key),
  };
}

export type RevokedByAlert = {
  userId: string;
  // Agents that lost an API key: their sockets close too.
  agentIds: string[];
};

/**
 * One transaction: the key, the API keys of the user and of the user's agents
 * made at or after the key, every session of the user, and the alert row
 * itself (the link works once). Two clicks: the second waits for the row
 * lock and finds nothing.
 */
export async function revokeByPasskeyAlert(
  token: string,
): Promise<RevokedByAlert | null> {
  return db.transaction(async (tx) => {
    const found = await findAlert(tx, token, true);
    if (!found) return null;
    const { userId, addedAt } = found.value;
    await tx
      .delete(schema.passkeyTable)
      .where(
        and(
          eq(schema.passkeyTable.id, found.passkeyId),
          eq(schema.passkeyTable.userId, userId),
        ),
      );
    const agents = await tx
      .select({ id: agentProfileTable.userId })
      .from(agentProfileTable)
      .where(eq(agentProfileTable.ownerId, userId));
    const removedKeys = await tx
      .delete(schema.apikeyTable)
      .where(
        and(
          inArray(schema.apikeyTable.referenceId, [
            userId,
            ...agents.map((agent) => agent.id),
          ]),
          gte(schema.apikeyTable.createdAt, new Date(addedAt)),
        ),
      )
      .returning({ referenceId: schema.apikeyTable.referenceId });
    await tx
      .delete(schema.sessionTable)
      .where(eq(schema.sessionTable.userId, userId));
    await tx.delete(table).where(eq(table.id, found.rowId));
    const agentIds = [
      ...new Set(
        removedKeys.map((key) => key.referenceId).filter((id) => id !== userId),
      ),
    ];
    return { userId, agentIds };
  });
}
