import { describe, expect, it } from "vite-plus/test";
import { backlogWarnings, resolveBacklogIds } from "./resolve-backlog-ids";

const page = (
  pageId: string,
  backlogId: string | null,
  createdTime: string,
) => ({
  key: `k-${pageId}`,
  pageId,
  backlogId,
  createdTime,
});
const NONE = { outside: new Set<string>(), byPage: new Map<string, string>() };

describe("resolveBacklogIds", () => {
  it("gives the ID to the earliest page, then the lower page id", () => {
    const { dropped, groups } = resolveBacklogIds(
      [
        page("c", "FIX-07", "2026-08-01T10:00:00.000Z"),
        page("b", "FIX-07", "2026-08-01T10:00:00.000Z"),
        page("a", "FIX-07", "2026-08-02T10:00:00.000Z"),
        page("d", "FIX-08", "2026-08-01T10:00:00.000Z"),
      ],
      NONE,
    );
    expect(groups).toEqual([
      { value: "FIX-07", holder: "b", footer: ["c", "a"] },
    ]);
    expect([...dropped]).toEqual(["k-c", "k-a"]);
  });

  it("leaves the ID with the card that holds it now", () => {
    const { groups } = resolveBacklogIds(
      [
        page("a", "FIX-07", "2026-08-01T10:00:00.000Z"),
        page("b", "FIX-07", "2026-08-02T10:00:00.000Z"),
      ],
      { ...NONE, byPage: new Map([["FIX-07", "b"]]) },
    );
    expect(groups).toEqual([{ value: "FIX-07", holder: "b", footer: ["a"] }]);
  });

  it("moves every page to the footer when a card outside the mirror holds it", () => {
    const { dropped, groups } = resolveBacklogIds(
      [page("a", "FIX-07", "2026-08-01T10:00:00.000Z")],
      { ...NONE, outside: new Set(["FIX-07"]) },
    );
    expect(groups).toEqual([{ value: "FIX-07", holder: null, footer: ["a"] }]);
    expect(dropped.has("k-a")).toBe(true);
  });

  it("tells values apart by their raw text", () => {
    const { groups } = resolveBacklogIds(
      [
        page("a", "FIX-07", "2026-08-01T10:00:00.000Z"),
        page("b", " FIX-07", "2026-08-01T10:00:00.000Z"),
      ],
      NONE,
    );
    expect(groups).toEqual([]);
  });
});

describe("backlogWarnings", () => {
  it("counts the footer cards, then names each holder and the rest by page id", () => {
    expect(
      backlogWarnings([
        { value: "FIX-07", holder: "b", footer: ["c", "a"] },
        { value: "B-1", holder: null, footer: ["z"] },
      ]),
    ).toEqual([
      "Kept a Backlog ID another card holds in the footer of 3 cards: FIX-07, B-1.",
      "Backlog ID FIX-07: held by page b; in the footer: c, a.",
      "Backlog ID B-1: held by a card outside this mirror; in the footer: z.",
    ]);
    expect(backlogWarnings([])).toEqual([]);
  });
});
