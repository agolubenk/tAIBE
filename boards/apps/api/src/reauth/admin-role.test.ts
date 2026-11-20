import { describe, expect, it } from "vite-plus/test";
import { ADMIN_PLUGIN_OPTIONS, canUpdateUsers } from "./admin-role";

describe("canUpdateUsers (TB-31 R-5, release N14)", () => {
  it("is true only for a role the admin plugin lets update users", () => {
    expect(canUpdateUsers("admin")).toBe(true);
    expect(canUpdateUsers("user,admin")).toBe(true);
    expect(canUpdateUsers("user")).toBe(false);
    expect(canUpdateUsers(null)).toBe(false);
    expect(canUpdateUsers(undefined)).toBe(false);
    expect(canUpdateUsers("")).toBe(false);
    expect(canUpdateUsers("owner")).toBe(false);
    // Not a role: an inherited property of the roles object.
    expect(canUpdateUsers("constructor")).toBe(false);
  });

  it("holds while the plugin has no own admin ids or roles", () => {
    // If one is added, canUpdateUsers no longer copies the plugin's rule.
    expect(Object.keys(ADMIN_PLUGIN_OPTIONS).sort()).toEqual([
      "adminRoles",
      "defaultRole",
    ]);
  });
});
