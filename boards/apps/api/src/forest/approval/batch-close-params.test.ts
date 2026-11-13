import { describe, expect, it } from "vite-plus/test";
import { approvalParamsHash } from "./approval-params";
import {
  batchCloseItems,
  batchCloseParams,
  finalTarget,
  isBatchClose,
  isClosed,
  parseBatchClose,
  projectCounts,
} from "./batch-close-params";
import { batchReport, skipText } from "./batch-close-report";

const batch = {
  cards: [
    { id: "t1", from: "grilling", key: "APP-1" },
    { id: "t2", from: "в-работе", key: "HRH-7" },
  ],
  targets: new Map([
    ["p1", "done"],
    ["p2", "готово"],
  ]),
};

describe("batch close params (TB-108)", () => {
  it("reads back what it stores", () => {
    const params = batchCloseParams(batch);
    expect(isBatchClose("close_task", params)).toBe(true);
    expect(isBatchClose("close_task", { status: "done" })).toBe(false);
    expect(isBatchClose("attach_label", params)).toBe(false);
    expect(parseBatchClose(params)).toEqual(batch);
  });

  it("refuses parts that do not line up", () => {
    const params = batchCloseParams(batch);
    expect(parseBatchClose({ ...params, from: "grilling" })).toBeNull();
    expect(parseBatchClose({ ...params, targets: "" })).toBeNull();
    expect(parseBatchClose({ ...params, targets: "p1" })).toBeNull();
    expect(parseBatchClose(null)).toBeNull();
  });

  // R-6: the hash binds the cards, the status each had and the targets.
  it("binds every card's status and every target in the hash", () => {
    const hash = (b: typeof batch) =>
      approvalParamsHash("close_task", "ws", batchCloseItems(b));
    const base = hash(batch);
    expect(hash({ ...batch, cards: [...batch.cards].reverse() })).toBe(base);
    expect(
      hash({
        ...batch,
        cards: [batch.cards[0]!, { ...batch.cards[1]!, from: "to-do" }],
      }),
    ).not.toBe(base);
    expect(
      hash({
        ...batch,
        targets: new Map([
          ["p1", "done"],
          ["p2", "done"],
        ]),
      }),
    ).not.toBe(base);
    expect(hash({ ...batch, cards: [batch.cards[0]!] })).not.toBe(base);
  });

  it("counts cards per project for the owner", () => {
    expect(projectCounts(["APP-1", "HRH-2", "APP-3", "GPL-OLD-4"])).toBe(
      "APP 2, GPL-OLD 1, HRH 1",
    );
  });
});

describe("batch close target and report", () => {
  it("targets the first final column that is not «Брёвна»", () => {
    expect(
      finalTarget([
        { slug: "closed", isFinal: true, position: 7 },
        { slug: "done", isFinal: true, position: 6 },
        { slug: "to-do", isFinal: false, position: 1 },
      ]),
    ).toBe("done");
    expect(
      finalTarget([{ slug: "closed", isFinal: true, position: 7 }]),
    ).toBeNull();
  });

  it("treats the owner's stage as not closed yet", () => {
    const columns = [
      { slug: "confirmation", isFinal: false, position: 5 },
      { slug: "done", isFinal: true, position: 6 },
    ];
    expect(isClosed(columns, "confirmation")).toBe(false);
    expect(isClosed(columns, "done")).toBe(true);
    expect(isClosed(columns, "archived")).toBe(true);
  });

  it("reports closed cards and names the skipped ones with the reason", () => {
    expect(batchReport(3, 3, [])).toBe("закрыто 3 из 3.");
    expect(
      batchReport(1, 3, [
        { key: "APP-2", reason: "changed" },
        { key: "APP-3", reason: "http_409: conflict" },
      ]),
    ).toBe(
      "закрыто 1 из 3; пропущено 2: APP-2 (изменилась после заявки), APP-3 (не приняла изменение).",
    );
    const many = Array.from({ length: 25 }, (_, i) => ({
      key: `APP-${i}`,
      reason: "leased",
    }));
    expect(batchReport(0, 25, many)).toMatch(/и ещё 5\.$/);
    expect(skipText("target_gone")).toBe("удалена");
  });
});
