import { describe, expect, it } from "vite-plus/test";
import { failText } from "../owner-queue/show-outcome";
import { approvedStatusFailure } from "./approved-status";

const statuses = [
  { slug: "to-do", closes: false },
  { slug: "done", closes: true },
  { slug: "planned", closes: false },
  { slug: "archived", closes: true },
];

describe("approvedStatusFailure — the approved slug at apply time (TB-90)", () => {
  it("passes a closing slug for a close and an open slug for a reopen", () => {
    expect(approvedStatusFailure(statuses, "done", true)).toBeNull();
    expect(approvedStatusFailure(statuses, "to-do", false)).toBeNull();
  });

  it("names the gone slug and the statuses of the same kind", () => {
    expect(approvedStatusFailure(statuses, "закрыто", true)).toBe(
      "status_gone: «закрыто» is not a status of the card's project now; ask the owner again for one of: done, archived",
    );
    expect(approvedStatusFailure(statuses, "in-work", false)).toBe(
      "status_gone: «in-work» is not a status of the card's project now; ask the owner again for one of: to-do, planned",
    );
  });

  it("refuses a close that does not close and a reopen that closes", () => {
    expect(approvedStatusFailure(statuses, "to-do", true)).toMatch(
      /^status_not_closing: «to-do»/,
    );
    expect(approvedStatusFailure(statuses, "done", false)).toMatch(
      /^status_closes: «done»/,
    );
  });

  it("says so when the project has no status of the kind", () => {
    expect(
      approvedStatusFailure([{ slug: "to-do", closes: false }], "done", true),
    ).toBe(
      "status_gone: «done» is not a status of the card's project now; the project has no closing status",
    );
  });

  it("gives the owner queue words for each reason", () => {
    for (const code of ["status_gone", "status_not_closing", "status_closes"]) {
      expect(failText(`${code}: x`)).toContain("нужна новая заявка");
    }
  });
});
