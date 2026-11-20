import { isAllowedUsername, isEmailLogin } from "@kaneo/permissions";
import { z } from "zod/v4";

// t-boards: inside the private network the owner signs in as admin/admin
// (spec R-006). The account is seeded by apps/api/scripts/seed-local-admin.ts
// under this email; the login field accepts the short name as an alias.
// `admin` is a reserved login (TB-31 R-1), so no one else can own it.
export const LOCAL_ADMIN_LOGIN = "admin";
export const LOCAL_ADMIN_EMAIL = "admin@t-boards.local";

export function resolveSignInEmail(login: string): string {
  const value = login.trim();
  return value.toLowerCase() === LOCAL_ADMIN_LOGIN ? LOCAL_ADMIN_EMAIL : value;
}

/** TB-31 R-1: a value with `@` (or the admin alias) signs in by email, else by login. */
export function signInRoute(login: string): "email" | "username" {
  const value = resolveSignInEmail(login);
  return isEmailLogin(value) ? "email" : "username";
}

export function isValidSignInLogin(login: string): boolean {
  if (signInRoute(login) === "username") return isAllowedUsername(login.trim());
  return z.email().safeParse(resolveSignInEmail(login)).success;
}
