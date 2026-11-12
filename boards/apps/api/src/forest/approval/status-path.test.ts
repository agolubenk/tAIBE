import { describe, expect, it } from "vite-plus/test";
import { statusPath } from "./status-path";

describe("statusPath (TB-102 R-8)", () => {
  it("closes from review through done", () => {
    expect(statusPath("in-review", "closed")).toEqual({
      kind: "steps",
      steps: ["done", "closed"],
    });
  });

  it("closes from done in one step", () => {
    expect(statusPath("done", "closed")).toEqual({
      kind: "steps",
      steps: ["closed"],
    });
  });

  it("moves to done in one step", () => {
    expect(statusPath("in-review", "done")).toEqual({
      kind: "steps",
      steps: ["done"],
    });
  });

  it("reports a card already in the target", () => {
    expect(statusPath("closed", "closed")).toEqual({ kind: "already" });
  });

  it("refuses to leave «Брёвна»", () => {
    expect(statusPath("closed", "to-do")).toEqual({
      kind: "unreachable",
      reason: "card_is_closed",
    });
  });
});
