import { describe, expect, it } from "vite-plus/test";
import { MASKED_MATCH_PAGE_BYTES, maskedMatchPage } from "./masked-match-page";

const rows = (...sizes: number[]) =>
  sizes.map((bytes, index) => ({ id: String(index), bytes }));
const MIB = 1024 * 1024;

describe("maskedMatchPage (TB-191)", () => {
  it("keeps the rows up to the page size", () => {
    expect(maskedMatchPage(rows(1, 1, 1), 2).map((row) => row.id)).toEqual([
      "0",
      "1",
    ]);
    expect(maskedMatchPage(rows(1, 1), 5)).toHaveLength(2);
    expect(maskedMatchPage([], 5)).toEqual([]);
  });

  it("stops before the row that goes over the byte budget", () => {
    const half = MASKED_MATCH_PAGE_BYTES / 2;
    expect(maskedMatchPage(rows(half, half, 1), 10)).toHaveLength(2);
    expect(maskedMatchPage(rows(half + 1, half), 10)).toHaveLength(1);
    expect(MASKED_MATCH_PAGE_BYTES).toBe(MIB);
  });

  it("keeps one row larger than the budget, so the cursor moves", () => {
    expect(maskedMatchPage(rows(9 * MIB, 1), 10)).toHaveLength(1);
  });
});
