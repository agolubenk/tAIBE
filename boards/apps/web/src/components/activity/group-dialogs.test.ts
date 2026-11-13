import { describe, expect, it } from "vite-plus/test";
import { groupDialogs, readDialog } from "./group-dialogs";

const said = (
  id: string,
  session?: string,
  { groupKey = "pair", fencingToken = 1, open = true } = {},
) => ({
  id,
  eventData: session
    ? { dialog: { groupKey, fencingToken, session, open } }
    : null,
});

describe("readDialog (TB-11)", () => {
  it("reads the dialog of a linked session's comment", () => {
    expect(readDialog(said("a", "writer", { open: false }).eventData)).toEqual({
      key: "pair#1",
      session: "writer",
      open: false,
    });
  });

  it("ignores other payloads and a malformed mark", () => {
    expect(readDialog(null)).toBeNull();
    expect(readDialog({ oldStatus: "to-do" })).toBeNull();
    expect(readDialog({ dialog: { groupKey: "pair" } })).toBeNull();
    expect(
      readDialog({ dialog: { groupKey: "pair", fencingToken: 1 } }),
    ).toBeNull();
  });
});

describe("groupDialogs (TB-11)", () => {
  it("shows a dialog as one block at the place of its first message", () => {
    const feed = [
      said("status"),
      said("w1", "writer"),
      said("owner"),
      said("r1", "reviewer"),
      said("w2", "writer"),
    ];
    expect(
      groupDialogs(feed).map((entry) =>
        entry.kind === "activity"
          ? entry.activity.id
          : `${entry.key}:${entry.messages.map((m) => m.id).join(",")}`,
      ),
    ).toEqual(["status", "pair#1:w1,r1,w2", "owner"]);
  });

  it("lists each session once, in the order it first spoke", () => {
    const [entry] = groupDialogs([
      said("w1", "writer"),
      said("r1", "reviewer"),
      said("w2", "writer"),
    ]);
    expect(entry?.kind === "dialog" && entry.sessions).toEqual([
      "writer",
      "reviewer",
    ]);
  });

  it("keeps two lease episodes of one group apart", () => {
    const entries = groupDialogs([
      said("a", "writer", { fencingToken: 1, open: false }),
      said("b", "writer", { fencingToken: 2, open: true }),
    ]);
    expect(entries).toHaveLength(2);
    expect(
      entries.map((entry) => entry.kind === "dialog" && entry.open),
    ).toEqual([false, true]);
  });

  it("leaves a feed without dialogs as it is", () => {
    const feed = [said("a"), said("b")];
    expect(groupDialogs(feed)).toEqual([
      { kind: "activity", activity: feed[0] },
      { kind: "activity", activity: feed[1] },
    ]);
  });
});
