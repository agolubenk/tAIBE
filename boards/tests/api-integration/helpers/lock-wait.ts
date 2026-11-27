import { sql } from "drizzle-orm";
import db from "../../../apps/api/src/database";

// Resolves once a session of the test database waits on a lock: the moment
// a concurrent writer has reached the row that the test transaction holds.
export async function untilSomeoneWaitsOnALock(who = "the other writer") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`,
    );
    if ((waiting.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${who} never waited on a row lock`);
}
