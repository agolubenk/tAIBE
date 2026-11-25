import { describe, expect, it } from "vite-plus/test";
import { decideRollback, withAutofill } from "./decide-rollback";

const edit = {
  title: { from: "Plant", to: "Plant (agent)" },
  priority: { from: "low", to: "high" },
};

describe("decideRollback (R-023)", () => {
  it("restores every field the edit changed", () => {
    const decision = decideRollback(edit, {
      title: "Plant (agent)",
      priority: "high",
      status: "to-do",
    });

    expect(decision).toEqual({
      ok: true,
      restore: { title: "Plant", priority: "low" },
    });
  });

  it("refuses when a later edit changed one of the fields", () => {
    const decision = decideRollback(edit, {
      title: "Plant (owner)",
      priority: "high",
    });

    expect(decision).toEqual({
      ok: false,
      reason: "changed again since: title; roll back the later edit first",
    });
  });

  it("compares lists and nulls by value", () => {
    const decision = decideRollback(
      {
        files: { from: [], to: ["a.ts"] },
        report: { from: "draft", to: null },
      },
      { files: ["a.ts"], report: null },
    );

    expect(decision).toEqual({
      ok: true,
      restore: { files: [], report: "draft" },
    });
  });

  it("refuses a field this path cannot restore", () => {
    const decision = decideRollback(
      { projectId: { from: "p1", to: "p2" }, title: edit.title },
      { projectId: "p2", title: "Plant (agent)" },
      { projectId: "move the card back first" },
    );

    expect(decision).toEqual({
      ok: false,
      reason: "projectId: move the card back first",
    });
  });
});

describe("withAutofill (AC-009, TB-69)", () => {
  const move = { status: { from: "to-do", to: "in-review" } };
  const fill = {
    assigneeId: { from: null, to: "agent-user" },
    startDate: { from: null, to: "2026-11-13T20:00:00.000Z" },
  };

  it("undoes the autofill with the move while it still holds", () => {
    const current = {
      status: "in-review",
      assigneeId: "agent-user",
      startDate: "2026-11-13T20:00:00.000Z",
    };
    expect(decideRollback(withAutofill(move, fill, current), current)).toEqual({
      ok: true,
      restore: { status: "to-do", assigneeId: null, startDate: null },
    });
  });

  it("leaves a field someone changed since, and still undoes the rest", () => {
    const current = {
      status: "in-review",
      assigneeId: "a-person",
      startDate: "2026-11-13T20:00:00.000Z",
    };
    expect(decideRollback(withAutofill(move, fill, current), current)).toEqual({
      ok: true,
      restore: { status: "to-do", startDate: null },
    });
  });

  it("composes a field both rows touched: from the edit's before to the fill's after", () => {
    const edit = { ...move, assigneeId: { from: "someone", to: null } };
    const current = { status: "in-review", assigneeId: "agent-user" };
    expect(
      withAutofill(edit, { assigneeId: fill.assigneeId }, current),
    ).toEqual({
      status: move.status,
      assigneeId: { from: "someone", to: "agent-user" },
    });
  });

  it("without an autofill row the edit is unchanged", () => {
    expect(withAutofill(move, undefined, {})).toBe(move);
  });
});
