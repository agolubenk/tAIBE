import type { AdminOptions } from "better-auth/plugins/admin";
import { defaultRoles } from "better-auth/plugins/admin/access";

/** The admin plugin's options (auth.ts). The fresh-session guard reads them too. */
export const ADMIN_PLUGIN_OPTIONS = {
  defaultRole: "user",
  adminRoles: ["admin"],
} satisfies AdminOptions;

type RoleName = keyof typeof defaultRoles;

/**
 * True when the admin plugin lets this role update users: the rule of its
 * `hasPermission` (better-auth 1.7.15 `plugins/admin/has-permission.mjs`) for
 * the options above. They set no `adminUserIds` and no `roles`, so the
 * default roles decide. A role list is comma-separated, as in the plugin.
 */
export function canUpdateUsers(role: string | null | undefined): boolean {
  return (role || ADMIN_PLUGIN_OPTIONS.defaultRole)
    .split(",")
    .some(
      (name) =>
        Object.hasOwn(defaultRoles, name) &&
        defaultRoles[name as RoleName].authorize({ user: ["update"] }).success,
    );
}
