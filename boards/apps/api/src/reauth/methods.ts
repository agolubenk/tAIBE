import { isSmtpConfigured } from "@kaneo/email";
import type { ReauthMethod } from "@kaneo/permissions";
import { and, eq, isNotNull } from "drizzle-orm";
import db, { schema } from "../database";
import { failureCount, isLockedOut } from "./store";

/** The password hash of the user's credential account, or null. */
export async function passwordHash(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ password: schema.accountTable.password })
    .from(schema.accountTable)
    .where(
      and(
        eq(schema.accountTable.userId, userId),
        eq(schema.accountTable.providerId, "credential"),
        isNotNull(schema.accountTable.password),
      ),
    )
    .limit(1);
  return row?.password ?? null;
}

/**
 * TB-31 R-5: only the ways this person can use now, in the contract order.
 * Under impersonation — none. After 10 failures in an hour — no password.
 * The email code does not depend on DISABLE_EMAIL_OTP_SIGN_IN.
 */
export async function availableMethods(
  userId: string,
  impersonated: boolean,
): Promise<ReauthMethod[]> {
  if (impersonated) return [];
  const [hash, failures] = await Promise.all([
    passwordHash(userId),
    failureCount(userId),
  ]);
  const methods: ReauthMethod[] = [];
  if (hash && !isLockedOut(failures)) methods.push("password");
  if (isSmtpConfigured()) methods.push("emailCode");
  return methods;
}
