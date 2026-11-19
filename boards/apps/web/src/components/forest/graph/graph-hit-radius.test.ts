import { describe, expect, it } from "vite-plus/test";
import { graphHitRadius } from "./graph-hit-radius";

describe("graphHitRadius (TB-223)", () => {
  it("keeps the desktop radius when the SVG is not shrunk", () => {
    expect(graphHitRadius(640, 640)).toBe(14);
    expect(graphHitRadius(1200, 640)).toBe(14);
  });

  it("gives at least 24 px on screen on a phone", () => {
    // 390 px window: the canvas is ~350 px wide.
    for (const width of [358, 350, 328, 300]) {
      const radius = graphHitRadius(width, 640);
      expect((2 * radius * width) / 640).toBeGreaterThanOrEqual(24);
    }
  });

  it("stops at 30 units so hit circles of nodes ~60 apart do not overlap", () => {
    expect(graphHitRadius(200, 640)).toBe(30);
  });

  it("falls back to the desktop radius before the SVG is measured", () => {
    expect(graphHitRadius(0, 640)).toBe(14);
    expect(graphHitRadius(Number.NaN, 640)).toBe(14);
  });
});
