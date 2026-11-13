import { describe, expect, it } from "vite-plus/test";
import {
  type DialogLease,
  decideDialogMark,
  isDialogOpen,
  readDialogMark,
} from "./session-dialog";

const now = new Date("2026-11-13T20:00:00Z");
const live = new Date("2026-11-13T20:05:00Z");
const lapsed = new Date("2026-11-13T19:59:59Z");

const front = { id: "agent:u-front", name: "front" };
const back = { id: "agent:u-back", name: "back" };

function lease(overrides: Partial<DialogLease> = {}): DialogLease {
  return {
    holderId: "agent:u-front",
    groupKey: "tb-11",
    fencingToken: 3,
    expiresAt: live,
    ...overrides,
  };
}

describe("decideDialogMark (R-026)", () => {
  it("puts the holder of a live group lease into the dialog", () => {
    expect(decideDialogMark(lease(), front, null, now)).toEqual({
      groupKey: "tb-11",
      fencingToken: 3,
      session: "front",
    });
  });

  it("puts a linked session that sends the groupKey into the dialog", () => {
    expect(decideDialogMark(lease(), back, "tb-11", now)).toEqual({
      groupKey: "tb-11",
      fencingToken: 3,
      session: "back",
    });
  });

  it("leaves out a session of another group or with no groupKey", () => {
    expect(decideDialogMark(lease(), back, "tb-12", now)).toBeNull();
    expect(decideDialogMark(lease(), back, null, now)).toBeNull();
  });

  it("has no dialog without a lease, on a solo lease or on a lapsed one", () => {
    expect(decideDialogMark(null, front, "tb-11", now)).toBeNull();
    expect(
      decideDialogMark(lease({ groupKey: null }), front, null, now),
    ).toBeNull();
    expect(
      decideDialogMark(lease({ expiresAt: lapsed }), front, null, now),
    ).toBeNull();
  });
});

describe("isDialogOpen (R-026)", () => {
  const mark = { groupKey: "tb-11", fencingToken: 3 };
  const inWork = { inWork: true };

  it("is open while its lease episode lives and the card is in work", () => {
    expect(isDialogOpen(mark, lease(), inWork, now)).toBe(true);
  });

  it("is archived once the lease ends or a new episode starts", () => {
    expect(isDialogOpen(mark, null, inWork, now)).toBe(false);
    expect(isDialogOpen(mark, lease({ expiresAt: lapsed }), inWork, now)).toBe(
      false,
    );
    expect(isDialogOpen(mark, lease({ fencingToken: 4 }), inWork, now)).toBe(
      false,
    );
    expect(isDialogOpen(mark, lease({ groupKey: "tb-12" }), inWork, now)).toBe(
      false,
    );
  });

  it("is archived when the card goes to review or closes", () => {
    expect(isDialogOpen(mark, lease(), { inWork: false }, now)).toBe(false);
  });
});

describe("readDialogMark", () => {
  it("reads only a well-formed mark", () => {
    expect(
      readDialogMark({
        dialog: { groupKey: "g", fencingToken: 1, session: "s", open: true },
      }),
    ).toEqual({ groupKey: "g", fencingToken: 1, session: "s" });
    expect(readDialogMark(null)).toBeNull();
    expect(readDialogMark({ oldStatus: "to-do" })).toBeNull();
    expect(readDialogMark({ dialog: { groupKey: "g" } })).toBeNull();
    expect(readDialogMark({ dialog: "g" })).toBeNull();
    expect(
      readDialogMark({ dialog: { groupKey: "g", fencingToken: 1 } }),
    ).toBeNull();
  });
});
