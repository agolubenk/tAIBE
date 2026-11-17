import { describe, expect, it } from "vite-plus/test";
import { rowProduct } from "./plan-types";
import { readOwnerQueueConfig } from "./queue-config";

const base = {
  OQ_URL: "https://ops.test",
  OQ_TOKEN_FILE: "/run/secrets/oq",
  OQ_TOKEN_NAME: "t-boards",
  OQ_WORKSPACE_PRODUCTS: "lav=hr-helper,eval=hr-helper",
};

describe("OQ_PLAN_PRODUCTS (TB-106)", () => {
  it("plans a mapped workspace under its queue product without the variable", () => {
    const config = readOwnerQueueConfig(base);
    expect([...(config?.plan.products ?? [])]).toEqual([
      ["lav", "hr-helper"],
      ["eval", "hr-helper"],
    ]);
  });

  it("names the plan product and keeps the queue product for items", () => {
    const config = readOwnerQueueConfig({
      ...base,
      OQ_PLAN_PRODUCTS: " eval = taibe , other=x-y, bad=Taibe!",
    });
    expect([...(config?.products ?? [])]).toEqual([
      ["lav", "hr-helper"],
      ["eval", "hr-helper"],
    ]);
    // A workspace not mapped for the queue is not read, so it has no plan.
    expect([...(config?.plan.products ?? [])]).toEqual([
      ["lav", "hr-helper"],
      ["eval", "taibe"],
    ]);
  });

  it("does not turn the sync on by itself", () => {
    expect(
      readOwnerQueueConfig({
        ...base,
        OQ_WORKSPACE_PRODUCTS: "",
        OQ_PLAN_PRODUCTS: "eval=taibe",
      }),
    ).toBeNull();
  });
});

describe("rowProduct (TB-106, queue_focus.py plan_rows)", () => {
  const products = ["hr-helper", "taibe"];

  it("gives a prefixed row to its product and the rest to the default", () => {
    expect(rowProduct("w-taibe-unplanned", products)).toBe("taibe");
    expect(rowProduct("w-taibe-focus", products)).toBe("taibe");
    expect(rowProduct("w-n-high", products)).toBe("hr-helper");
    expect(rowProduct("w-hr-helper-unplanned", products)).toBe("hr-helper");
  });

  it("takes the longest prefix and skips docs that are not rows", () => {
    expect(rowProduct("w-taibe-x-1", ["hr-helper", "taibe", "taibe-x"])).toBe(
      "taibe-x",
    );
    expect(rowProduct("cards-stats", products)).toBeNull();
    expect(rowProduct("w-n-high", ["taibe"])).toBeNull();
  });
});
