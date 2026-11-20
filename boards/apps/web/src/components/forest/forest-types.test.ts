import { describe, expect, it } from "vite-plus/test";
import {
  FOREST_TABS,
  isForestOwnerRole,
  visibleForestTabs,
} from "./forest-types";

describe("visibleForestTabs (TB-156)", () => {
  it("shows the owner queue to the owner alone", () => {
    expect(visibleForestTabs(true)).toEqual(FOREST_TABS);
    expect(visibleForestTabs(false)).not.toContain("queue");
    expect(visibleForestTabs(false)).toHaveLength(FOREST_TABS.length - 1);
  });
});

describe("isForestOwnerRole (TB-156)", () => {
  it("follows the API: only the role admin itself is the owner", () => {
    expect(isForestOwnerRole("admin")).toBe(true);
    for (const role of [
      "user,admin",
      "admin,user",
      "user",
      "",
      null,
      undefined,
    ]) {
      expect(isForestOwnerRole(role)).toBe(false);
    }
  });
});
