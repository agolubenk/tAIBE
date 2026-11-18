import { and, eq, gt } from "drizzle-orm";
import db, { schema } from "../database";

// TB-31 R-5, owner taibe-d-tb31-agent-key-1811 = A: a session that the device
// flow made (kaneo-cli, kaneo-mcp) issues agent keys without a fresh sign-in.
// The device approval in the browser is under the guard, so only a person who
// confirmed it gets such a session. The mark is a `verification` row; expired
// rows go with better-auth's own sweep, as the fresh marks do.
const table = schema.verificationTable;
// A used session lives on (better-auth refreshes it); each pass renews the
// mark, so only a session idle for this long confirms once more.
const DEVICE_MARK_SECONDS = 30 * 24 * 3600;

export const deviceId = (sessionId: string) => `tb-device:${sessionId}`;

const until = () => new Date(Date.now() + DEVICE_MARK_SECONDS * 1000);

/** A new session id is never reused, so there is no old row to replace. */
export async function markDeviceSession(sessionId: string, userId: string) {
  await db.insert(table).values({
    identifier: deviceId(sessionId),
    value: userId,
    expiresAt: until(),
  });
}

/** True for a live mark of this session and user; a pass renews the mark. */
export async function isDeviceSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const renewed = await db
    .update(table)
    .set({ expiresAt: until() })
    .where(
      and(
        eq(table.identifier, deviceId(sessionId)),
        eq(table.value, userId),
        gt(table.expiresAt, new Date()),
      ),
    )
    .returning({ id: table.id });
  return renewed.length > 0;
}
