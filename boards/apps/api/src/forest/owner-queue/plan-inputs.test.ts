import { describe, expect, it } from "vite-plus/test";
import {
  inputsRowId,
  itemProduct,
  namedAt,
  namedIn,
  ownerTexts,
  sharedKeys,
} from "./plan-inputs";
import type { RecentCard } from "./plan-types";
import type { QueueDoc } from "./queue-client";

const NOW = new Date("2026-11-14T06:00:00Z");
const PRODUCTS = ["hr-helper", "taibe"];
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
    doc("d-1", {
      note: "и ещё GLOB-35",
      ownerAt: "2026-11-13T09:00:00Z",
      agentNote: "беру TB-77, w-taibe-agent",
    }),
    doc("c-1", { note: "проверил APP-590", ownerAt: "2026-11-13T09:00:00Z" }),
    doc("m-1", { note: "APP-7 merged", ownerAt: "2026-11-13T09:00:00Z" }),
    doc("s-1", { note: "OPS-9 ok", ownerAt: "2026-11-13T09:00:00Z" }),
    doc("d-old", { note: "APP-2", ownerAt: "2026-11-02T09:00:00Z" }),
  ];

  it("takes the inbox text and the owner's notes on decisions and checks", () => {
    const texts = ownerTexts(items, checks, PRODUCTS, NOW).map((one) => one.text);
    expect(texts).toEqual([
      "сломалось APP-584",
      "и ещё GLOB-35",
      "проверил APP-590",
    ]);
  });

  it("never reads the agent's note: an agent's keys are not the owner's inputs", () => {
    const named = namedIn(ownerTexts(items, checks, PRODUCTS, NOW));
    expect([...named.keys.keys()]).not.toContain("IS-61");
    expect([...named.keys.keys()]).not.toContain("TB-77");
    expect([...named.rows.keys()]).toEqual([]);
  });

  it("ignores merge and server notes and inputs older than 7 days", () => {
    const texts = ownerTexts(items, checks, PRODUCTS, NOW)
      .map((one) => one.text)
      .join(" ");
    expect(texts).toContain("APP-590");
    for (const key of ["APP-7", "OPS-9", "APP-1", "APP-2"]) {
      expect(texts).not.toContain(key);
    }
  });

  it("takes the product of a note from its item id; the inbox has none", () => {
    const answered = [
      doc("d-taibe-x", { kind: "decision", title: "d" }),
      doc("c-hr-y", { kind: "check", title: "c" }),
    ];
    const notes = [
      doc("d-taibe-x", { note: "OPS-67 первым", ownerAt: "2026-11-13T09:00:00Z" }),
      doc("c-hr-y", { note: "OPS-5", ownerAt: "2026-11-13T09:00:00Z" }),
    ];
    const texts = ownerTexts(
      [...items, ...answered],
      [...checks, ...notes],
      PRODUCTS,
      NOW,
    );
    expect(texts.map((one) => [one.text, one.product])).toEqual([
      ["сломалось APP-584", null],
      ["и ещё GLOB-35", null],
      ["проверил APP-590", null],
      ["OPS-67 первым", "taibe"],
      ["OPS-5", "hr-helper"],
    ]);
  });
});

describe("itemProduct", () => {
  it("reads the plan product from d-<tag>-…; hr is the default product", () => {
    expect(itemProduct("d-taibe-gl10-sessions-1411", PRODUCTS)).toBe("taibe");
    expect(itemProduct("d-hr-focus-1311", PRODUCTS)).toBe("hr-helper");
    expect(itemProduct("c-hr-helper-x", PRODUCTS)).toBe("hr-helper");
    for (const id of ["d-1", "d-20261114-135d8d", "d-merge-guard-3010", "i-1"]) {
      expect(itemProduct(id, PRODUCTS)).toBeNull();
    }
  });
});

describe("namedIn", () => {
  it("names each key and row once, with the latest time", () => {
    const named = namedIn([
      { text: "APP-1, APP-1 и w-n-high", at: 1, product: null },
      { text: "снова APP-1, IS-61; не ключ: a-1, X-1", at: 5, product: null },
      { text: "w-n-high", at: 3, product: null },
    ]);
    expect([...named.keys]).toEqual([
      ["APP-1", 5],
      ["IS-61", 5],
    ]);
    expect([...named.rows]).toEqual([["w-n-high", 3]]);
    expect(named.byProduct.size).toBe(0);
  });

  it("keeps the keys of a product's texts apart", () => {
    const named = namedIn([
      { text: "OPS-67 первым", at: 4, product: "taibe" },
      { text: "OPS-67 и TB-5", at: 2, product: null },
      { text: "APP-1", at: 3, product: "hr-helper" },
    ]);
    expect([...named.keys]).toEqual([
      ["OPS-67", 4],
      ["TB-5", 2],
      ["APP-1", 3],
    ]);
    expect([...(named.byProduct.get("taibe") ?? [])]).toEqual([["OPS-67", 4]]);
    expect([...(named.byProduct.get("hr-helper") ?? [])]).toEqual([["APP-1", 3]]);
  });

  it("names the inputs row of a product", () => {
    expect(inputsRowId("hr-helper")).toBe("w-n-inputs");
    expect(inputsRowId("taibe")).toBe("w-taibe-inputs");
  });
});

describe("namedAt (one key, two products)", () => {
  const card = (key: string, product: string) =>
    ({ key, product }) as RecentCard;
  const cards = [card("OPS-67", "hr-helper"), card("OPS-67", "taibe"), card("TB-5", "taibe")];

  it("finds the keys on the cards of 2+ products", () => {
    expect([...sharedKeys(cards)]).toEqual(["OPS-67"]);
  });

  it("counts a shared key only for the product of its text", () => {
    const named = namedIn([{ text: "OPS-67 первым", at: 4, product: "taibe" }]);
    const shared = sharedKeys(cards);
    expect(namedAt(named, shared, "taibe", "OPS-67")).toBe(4);
    expect(namedAt(named, shared, "hr-helper", "OPS-67")).toBeUndefined();
  });

  it("skips a shared key from the inbox; a key of one product counts as before", () => {
    const named = namedIn([{ text: "OPS-67 и TB-5", at: 2, product: null }]);
    const shared = sharedKeys(cards);
    expect(namedAt(named, shared, "taibe", "OPS-67")).toBeUndefined();
    expect(namedAt(named, shared, "hr-helper", "OPS-67")).toBeUndefined();
    expect(namedAt(named, shared, "taibe", "TB-5")).toBe(2);
  });
});
