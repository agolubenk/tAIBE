import { describe, expect, it } from "vite-plus/test";
import { statusPatch } from "./plan-status";
import type { BoardCard } from "./plan-types";

const TODAY = "2026-11-13";
const card = (status: string, final = false): BoardCard => ({
  status,
  final,
  closedAt: final ? new Date("2026-11-12T10:00:00Z") : null,
});
const done = card("done", true);
const todo = card("to-do");

describe("statusPatch (TB-106 F4)", () => {
  it("closes a row whose cards are all found and final, end = today", () => {
    const patch = statusPatch(
      { status: "doing", planEnd: "2026-11-20" },
      [done, card("closed", true)],
      TODAY,
    );
    expect(patch).toEqual({ status: "done", end: TODAY });
  });

  it("keeps a done row done and its end", () => {
    expect(
      statusPatch({ status: "done", end: "2026-11-01" }, [done], TODAY),
    ).toEqual({});
  });

  it("does not close a row with a card the board does not know", () => {
    expect(
      statusPatch({ status: "planned" }, [done, undefined], TODAY),
    ).toEqual({});
  });

  it("does not close a row without cards", () => {
    expect(statusPatch({ status: "planned" }, [], TODAY)).toEqual({});
  });

  it("never changes a blocked row or an owner's row", () => {
    expect(statusPatch({ status: "blocked" }, [done], TODAY)).toEqual({});
    expect(
      statusPatch({ status: "blocked" }, [card("in-progress")], TODAY),
    ).toEqual({});
    expect(
      statusPatch({ status: "planned", who: "owner" }, [done], TODAY),
    ).toEqual({});
    expect(
      statusPatch(
        { status: "done", who: "owner", end: "2026-11-01" },
        [todo],
        TODAY,
      ),
    ).toEqual({});
  });

  it("reopens a done row with an open card and removes its end", () => {
    expect(
      statusPatch(
        { status: "done", end: "2026-11-10", planEnd: "2026-11-09" },
        [done, todo],
        TODAY,
      ),
    ).toEqual({ status: "planned", end: null });
  });

  it("reopens a done row without an end and writes no end", () => {
    expect(statusPatch({ status: "done" }, [todo], TODAY)).toEqual({
      status: "planned",
    });
  });

  it("makes a row doing when a card is in progress or in review", () => {
    expect(
      statusPatch({ status: "planned" }, [todo, card("in-progress")], TODAY),
    ).toEqual({ status: "doing" });
    expect(
      statusPatch({ status: "planned" }, [card("in-review"), done], TODAY),
    ).toEqual({ status: "doing" });
    expect(
      statusPatch(
        { status: "done", end: "2026-11-10" },
        [card("in-review")],
        TODAY,
      ),
    ).toEqual({ status: "doing", end: null });
  });

  it("keeps the status otherwise", () => {
    expect(
      statusPatch({ status: "doing" }, [card("in-progress")], TODAY),
    ).toEqual({});
    expect(statusPatch({ status: "planned" }, [todo, done], TODAY)).toEqual({});
    expect(statusPatch({ status: "doing" }, [todo], TODAY)).toEqual({});
  });

  it("never writes planEnd", () => {
    const cases: [Record<string, unknown>, (BoardCard | undefined)[]][] = [
      [{ status: "planned", planEnd: "2026-11-01" }, [done]],
      [{ status: "done", planEnd: "2026-11-01", end: "2026-11-02" }, [todo]],
      [{ status: "planned", planEnd: "2026-11-01" }, [card("in-progress")]],
    ];
    for (const [data, cards] of cases) {
      expect(statusPatch(data, cards, TODAY)).not.toHaveProperty("planEnd");
    }
  });
});
