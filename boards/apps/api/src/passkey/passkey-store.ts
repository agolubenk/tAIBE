import { count, eq } from "drizzle-orm";
import db, { schema } from "../database";

const table = schema.passkeyTable;

/** How many passkeys the user has (R-6 limit, R-5 window methods). */
export async function passkeyCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(table)
    .where(eq(table.userId, userId));
  return row?.value ?? 0;
}

/** The user a credential belongs to, or null. `credential_id` is unique (0088). */
export async function passkeyOwner(
  credentialId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ userId: table.userId })
    .from(table)
    .where(eq(table.credentialID, credentialId))
    .limit(1);
  return row?.userId ?? null;
}
