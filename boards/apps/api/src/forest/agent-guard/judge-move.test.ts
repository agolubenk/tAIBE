import { describe, expect, it } from "vite-plus/test";
import { pickDestinationColumn } from "../../task/controllers/pick-destination-column";
import { judgeLanding } from "./judge-move";

const columns = [{ slug: "new" }, { slug: "to-do" }, { slug: "done" }];

describe("pickDestinationColumn — where move-task puts the card (TB-82)", () => {
  it("takes the requested column, and nothing when the project lacks it", () => {
    expect(pickDestinationColumn(columns, "to-do", "done")).toEqual({
      slug: "done",
    });
    expect(pickDestinationColumn(columns, "to-do", "closed")).toBeUndefined();
  });

  it("without a request keeps the card's slug, else the first column", () => {
    expect(pickDestinationColumn(columns, "to-do")).toEqual({ slug: "to-do" });
    expect(pickDestinationColumn(columns, "in-review")).toEqual({
      slug: "new",
    });
    expect(pickDestinationColumn([], "to-do")).toBeUndefined();
  });
});

describe("judgeLanding — a move keeps the card open, or closed in its stage (TB-82)", () => {
  const open = (slug: string) => ({ slug, closed: false });
  const closed = (slug: string) => ({ slug, closed: true });

  it("allows open to open, and the same closing stage", () => {
    expect(judgeLanding(open("to-do"), open("new"))).toEqual({
      kind: "allow",
      status: "new",
    });
    expect(judgeLanding(closed("done"), closed("done"))).toEqual({
      kind: "allow",
      status: "done",
    });
  });

  it("refuses a close, a reopen and a change of closing stage with the way round", () => {
    const closes = judgeLanding(open("to-do"), closed("done"));
    expect(closes.kind === "deny" && closes.reason).toContain("close_task");

    // A closed card without destinationStatus lands in the first column.
    const reopens = judgeLanding(closed("done"), open("new"));
    expect(reopens.kind === "deny" && reopens.reason).toContain("reopen_task");

    // The same slug, open in the new project: still a reopen.
    const sameSlug = judgeLanding(closed("done"), open("done"));
    expect(sameSlug.kind === "deny" && sameSlug.reason).toContain(
      "reopen_task",
    );

    // «Подтверждение» → «Готово» is the owner's close, not a relocation.
    const stage = judgeLanding(closed("confirmation"), closed("done"));
    expect(stage.kind === "deny" && stage.reason).toContain(
      "closing stage «confirmation» → «done»",
    );
  });
});
