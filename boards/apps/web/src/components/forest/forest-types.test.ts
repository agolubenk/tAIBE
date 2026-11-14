import { describe, expect, it } from "vite-plus/test";
import { FOREST_TABS, visibleForestTabs } from "./forest-types";

describe("visibleForestTabs (TB-156)", () => {
  it("shows the owner queue to the owner alone", () => {
    expect(visibleForestTabs(true)).toEqual(FOREST_TABS);
    expect(visibleForestTabs(false)).not.toContain("queue");
    expect(visibleForestTabs(false)).toHaveLength(FOREST_TABS.length - 1);
  });
});
