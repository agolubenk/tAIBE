import { describe, expect, it } from "vite-plus/test";
import {
  rankVisible,
  searchWindow,
  TOKEN_CALLER_SCAN_ROWS,
} from "./visible-rows";

const join = (...parts: string[]) => parts.join("");
const KEY = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const PREFIX = KEY.slice(0, 8);

type Row = {
  id: string;
  title: string;
  description: string | null;
  createdAt: Date;
  relevanceScore: number;
  fits: boolean;
};
const row = (
  id: string,
  title: string,
  description: string | null,
  day: number,
): Row => ({
  id,
  title,
  description,
  createdAt: new Date(Date.UTC(2026, 10, day)),
  relevanceScore: 3, // the stored score, which may come from a secret
  fits: true,
});
const taskFields = (r: Row) =>
  [
    [r.title, 3],
    [r.description, 2],
  ] as const;

describe("rankVisible (TB-191)", () => {
  it("drops a row that matches only inside a secret", () => {
    const rows = [
      row("a", `Key ${KEY}`, "no match", 3),
      row("b", "plain", `see ${PREFIX}`, 2),
    ];
    expect(rankVisible(rows, PREFIX, 10, taskFields).map((r) => r.id)).toEqual([
      "b",
    ]);
  });

  it("scores a row by its visible text, not by the stored score", () => {
    const rows = [row("a", `Key ${KEY}`, `rotate ${PREFIX}`, 3)];
    expect(rankVisible(rows, PREFIX, 10, taskFields)[0]?.relevanceScore).toBe(
      2,
    );
  });

  it("ranks by score, then by createdAt descending, and keeps the limit", () => {
    const rows = [
      row("new-desc", "x", "deploy", 5),
      row("old-title", "deploy", null, 1),
      row("mid-title", "deploy now", null, 3),
      row("old-desc", "y", "deploy later", 2),
    ];
    expect(rankVisible(rows, "deploy", 3, taskFields).map((r) => r.id)).toEqual(
      ["mid-title", "old-title", "new-desc"],
    );
  });
});

describe("searchWindow (TB-191)", () => {
  const rows = [row("a", `Key ${KEY}`, null, 3)];

  it("keeps the owner's limit, SQL order, and rows", () => {
    const owner = searchWindow(false, PREFIX, 20);
    expect(owner.rows).toBe(20);
    expect(owner.pick(rows, taskFields)).toBe(rows);
  });

  it("scans the newest rows for a caller with a token and keeps the visible ones", () => {
    const agent = searchWindow(true, PREFIX, 20);
    expect(agent.rows).toBe(TOKEN_CALLER_SCAN_ROWS);
    expect(agent.pick(rows, taskFields)).toEqual([]);
  });

  it("does not scan a candidate that came back over the byte budget", () => {
    const agent = searchWindow(true, "deploy", 20);
    const old = { ...row("old", "deploy", null, 1), fits: false };
    const found = agent.pick([row("new", "deploy", null, 2), old], taskFields);
    expect(found.map((r) => r.id)).toEqual(["new"]);
  });
});
