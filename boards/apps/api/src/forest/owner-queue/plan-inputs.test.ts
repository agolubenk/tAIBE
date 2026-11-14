import { describe, expect, it } from "vite-plus/test";
import { inputsRowId, namedIn, ownerTexts } from "./plan-inputs";
import type { QueueDoc } from "./queue-client";

const NOW = new Date("2026-11-14T06:00:00Z");
const doc = (id: string, data: Record<string, unknown>): QueueDoc => ({
  id,
  data,
  version: 1,
  updatedAt: 0,
});
const inbox = (id: string, text: string, receivedAt: string) =>
  doc(id, { kind: "inbox", title: "x", inbox: { text, receivedAt } });

describe("ownerTexts (TB-107)", () => {
  const items = [
    inbox("i-1", "сломалось APP-584", "2026-11-12T10:00:00Z"),
    inbox("i-old", "давно APP-1", "2026-11-01T10:00:00Z"),
    doc("d-1", { kind: "decision", title: "d" }),
    doc("c-1", { kind: "check", title: "c" }),
    doc("m-1", { kind: "merge", title: "m" }),
    doc("s-1", { kind: "server", title: "s" }),
    doc("d-old", { kind: "decision", title: "d" }),
  ];
  const checks = [
    doc("i-1", { agentNote: "карточка IS-61" }),
    doc("d-1", { note: "и ещё GLOB-35", ownerAt: "2026-11-13T09:00:00Z" }),
    doc("c-1", { note: "проверил APP-590", ownerAt: "2026-11-13T09:00:00Z" }),
    doc("m-1", { note: "APP-7 merged", ownerAt: "2026-11-13T09:00:00Z" }),
    doc("s-1", { note: "OPS-9 ok", ownerAt: "2026-11-13T09:00:00Z" }),
    doc("d-old", { note: "APP-2", ownerAt: "2026-11-02T09:00:00Z" }),
  ];

  it("takes inbox texts with the agent's note and notes on decisions and checks", () => {
    const texts = ownerTexts(items, checks, NOW).map((one) => one.text);
    expect(texts).toEqual([
      "сломалось APP-584",
      "карточка IS-61",
      "и ещё GLOB-35",
      "проверил APP-590",
    ]);
  });

  it("ignores merge and server notes and inputs older than 7 days", () => {
    const texts = ownerTexts(items, checks, NOW).join(" ");
    for (const key of ["APP-7", "OPS-9", "APP-1", "APP-2"]) {
      expect(texts).not.toContain(key);
    }
  });
});

describe("namedIn", () => {
  it("names each key and row once, with the latest time", () => {
    const named = namedIn([
      { text: "APP-1, APP-1 и w-n-high", at: 1 },
      { text: "снова APP-1, IS-61; не ключ: a-1, X-1", at: 5 },
      { text: "w-n-high", at: 3 },
    ]);
    expect([...named.keys]).toEqual([
      ["APP-1", 5],
      ["IS-61", 5],
    ]);
    expect([...named.rows]).toEqual([["w-n-high", 3]]);
  });

  it("names the inputs row of a product", () => {
    expect(inputsRowId("hr-helper")).toBe("w-n-inputs");
    expect(inputsRowId("taibe")).toBe("w-taibe-inputs");
  });
});
