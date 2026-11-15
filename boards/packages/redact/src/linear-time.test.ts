import { describe, expect, it } from "vite-plus/test";
import { growth, MAX_GROWTH, SCALE } from "../fixtures/linear-time";

// TB-205: the time tests of redact and restore pass only if the growth check
// tells linear work from quadratic work. These two jobs have a known growth.
function numbers(n: number): Int32Array {
  const items = new Int32Array(n);
  for (let i = 0; i < n; i += 1) items[i] = i % 7;
  return items;
}

function sumAll(items: Int32Array): number {
  let total = 0;
  for (const item of items) total += item;
  return total;
}

function sumPairs(items: Int32Array): number {
  let total = 0;
  for (const a of items) for (const b of items) total += a ^ b;
  return total;
}

describe("growth", () => {
  it("keeps the limit between linear and quadratic growth", () => {
    expect(MAX_GROWTH).toBeGreaterThan(SCALE);
    expect(MAX_GROWTH).toBeLessThan(SCALE * SCALE);
  });

  it("passes linear work", () => {
    expect(growth(numbers, sumAll, 2_000_000)).toBeLessThan(MAX_GROWTH);
  });

  // A pause in a small run makes the growth smaller, so this case takes the
  // largest of three checks.
  it("catches quadratic work", () => {
    const checks = [1, 2, 3].map(() => growth(numbers, sumPairs, 2_000));
    expect(Math.max(...checks)).toBeGreaterThan(MAX_GROWTH);
  });
});
