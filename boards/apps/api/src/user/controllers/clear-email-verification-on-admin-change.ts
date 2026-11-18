import { eq } from "drizzle-orm";
import db, { schema } from "../../database";

type UpdateHookContext = {
  path?: string;
  body?: { userId?: unknown };
};

/**
 * True when an admin update sets an email that differs from the target's
 * current one (trim, lower case). Shared by this hook and the TB-31 R-5
 * fresh-session guard, so both agree on what "an email change" is.
 */
export async function adminEmailChanges(
  userId: unknown,
  email: unknown,
): Promise<boolean> {
  if (typeof userId !== "string") {
    return false;
  }
  const [current] = await db
    .select({ email: schema.userTable.email })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .limit(1);
  if (!current) {
    return false;
  }
  const nextEmail = String(email ?? "")
    .trim()
    .toLowerCase();
  return nextEmail !== current.email.trim().toLowerCase();
}

export async function clearEmailVerificationOnAdminChange(
  data: Record<string, unknown>,
  ctx: UpdateHookContext | null | undefined,
) {
  if (ctx?.path !== "/admin/update-user" || !("email" in data)) {
    return;
  }
  if (!(await adminEmailChanges(ctx.body?.userId, data.email))) {
    return;
  }
  return { data: { ...data, emailVerified: false } };
}

export default clearEmailVerificationOnAdminChange;
