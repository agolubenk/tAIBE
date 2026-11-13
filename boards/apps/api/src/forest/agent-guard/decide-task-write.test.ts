import { describe, expect, it } from "vite-plus/test";
import { decideTaskWrite } from "./decide-task-write";

const current = {
  title: "Owner task",
  description: "Do X",
  status: "to-do",
  priority: "low",
};
const open = { closes: false, reopens: false, authoredByAgent: false };

describe("decideTaskWrite", () => {
  it("lets an agent move open statuses and touch nothing else", () => {
    expect(decideTaskWrite({ status: "in-progress" }, current, open)).toEqual({
      kind: "allow",
      approval: null,
    });
    expect(decideTaskWrite({}, current, open)).toEqual({
      kind: "allow",
      approval: null,
    });
  });

  it("refuses edits of the owner's title or description", () => {
    expect(decideTaskWrite({ title: "Mine now" }, current, open).kind).toBe(
      "deny",
    );
    expect(decideTaskWrite({ description: "" }, current, open).kind).toBe(
      "deny",
    );
  });

  it("treats a resent unchanged text as no edit", () => {
    expect(
      decideTaskWrite(
        { title: "Owner task", description: "Do X", status: "to-do" },
        current,
        open,
      ),
    ).toEqual({ kind: "allow", approval: null });
    expect(
      decideTaskWrite(
        { description: "" },
        { ...current, description: null },
        open,
      ).kind,
    ).toBe("allow");
  });

  it("lets an agent edit the text of a card an agent created", () => {
    expect(
      decideTaskWrite({ title: "Better" }, current, {
        ...open,
        authoredByAgent: true,
      }).kind,
    ).toBe("allow");
  });

  it("asks for the owner's «да» to close or reprioritise", () => {
    expect(
      decideTaskWrite({ status: "done" }, current, { ...open, closes: true }),
    ).toEqual({
      kind: "allow",
      approval: { action: "close_task", value: "done" },
    });
    expect(decideTaskWrite({ priority: "urgent" }, current, open)).toEqual({
      kind: "allow",
      approval: { action: "set_priority", value: "urgent" },
    });
  });

  it("does not ask again for a status the card already has", () => {
    expect(
      decideTaskWrite(
        { status: "done" },
        { ...current, status: "done" },
        { ...open, closes: true },
      ),
    ).toEqual({ kind: "allow", approval: null });
  });

  it("refuses closing and reprioritising in one request", () => {
    expect(
      decideTaskWrite({ status: "done", priority: "high" }, current, {
        ...open,
        closes: true,
      }).kind,
    ).toBe("deny");
  });

  // d-tb-reopen, owner 28.10: reopening a closed card needs a «да» too.
  it("asks for the owner's «да» to reopen a closed card", () => {
    const closed = { ...current, status: "done" };
    const reopens = { ...open, reopens: true };
    expect(decideTaskWrite({ status: "to-do" }, closed, reopens)).toEqual({
      kind: "allow",
      approval: { action: "reopen_task", value: "to-do" },
    });
    expect(
      decideTaskWrite({ status: "to-do", priority: "high" }, closed, reopens)
        .kind,
    ).toBe("deny");
    expect(decideTaskWrite({ status: "done" }, closed, reopens)).toEqual({
      kind: "allow",
      approval: null,
    });
  });

  // TB-80: a move to another project lands in a column of that project.
  it("asks about a move's landing even with the same slug or no status", () => {
    const closed = { ...current, status: "done" };
    const reopens = { ...open, reopens: true };
    expect(
      decideTaskWrite({ projectId: "p2" }, closed, {
        ...reopens,
        landing: "new",
      }),
    ).toEqual({
      kind: "allow",
      approval: { action: "reopen_task", value: "new" },
    });
    expect(
      decideTaskWrite({ projectId: "p2", status: "done" }, closed, {
        ...reopens,
        landing: "done",
      }),
    ).toEqual({
      kind: "allow",
      approval: { action: "reopen_task", value: "done" },
    });
    expect(
      decideTaskWrite({ projectId: "p2", status: "finished" }, closed, {
        ...open,
        landing: "finished",
      }),
    ).toEqual({ kind: "allow", approval: null });
  });

  // R-8: no «да» takes a card out of «Брёвна», so the move is not sent to
  // the owner.
  it("refuses to move a card in «Брёвна» instead of asking a «да»", () => {
    const logs = { ...current, status: "closed" };
    const decision = decideTaskWrite(
      { projectId: "p2", status: "closed" },
      logs,
      { ...open, closes: true, landing: "closed" },
    );
    expect(decision.kind === "deny" && decision.reason).toContain("terminal");
    // The same status inside the project is not a move.
    expect(decideTaskWrite({ status: "closed" }, logs, open)).toEqual({
      kind: "allow",
      approval: null,
    });
  });
});
