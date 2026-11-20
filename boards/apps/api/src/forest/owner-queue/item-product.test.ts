import { describe, expect, it } from "vite-plus/test";
import { productOfItemId } from "./item-product";

const PRODUCTS = ["hr-helper", "taibe"];

describe("productOfItemId (queue.match)", () => {
  it("finds the product tag anywhere in the id, as the Nerve does", () => {
    for (const id of [
      "d-taibe-hetty-1411",
      "c-taibe-x",
      "s-taibe-nerve-restart-1411",
      "d-serena-taibe-ram-0811",
      "s-restart-4-taibe-1211",
      "taibe-m-93",
      "d-taibe-hr-x",
    ]) {
      expect([id, productOfItemId(id, PRODUCTS)]).toEqual([id, "taibe"]);
    }
  });

  it("sees the merge form m-taibe<pr>-… and a tag at the end (SE-109)", () => {
    // The same rule as the Nerve's for_item: queue.match "-taibe(-|\d|$)".
    expect(productOfItemId("m-taibe310-1411", PRODUCTS)).toBe("taibe");
    expect(productOfItemId("s-restart-taibe", PRODUCTS)).toBe("taibe");
    expect(productOfItemId("d-hr2-x", PRODUCTS)).toBe("hr-helper");
  });

  it("does not take a tag inside another word", () => {
    expect(productOfItemId("d-taibeta-1", PRODUCTS)).toBeNull();
    expect(productOfItemId("d-hrm-1", PRODUCTS)).toBeNull();
  });

  it("gives hr to the default product and null to an id without a tag", () => {
    expect(productOfItemId("d-hr-focus-1311", PRODUCTS)).toBe("hr-helper");
    expect(productOfItemId("c-hr-helper-x", PRODUCTS)).toBe("hr-helper");
    for (const id of [
      "d-1",
      "d-20261114-135d8d",
      "d-merge-guard-3010",
      "i-1",
    ]) {
      expect(productOfItemId(id, PRODUCTS)).toBeNull();
    }
  });

  it("knows only the products it is given", () => {
    expect(productOfItemId("d-taibe-x", ["hr-helper"])).toBeNull();
    expect(productOfItemId("d-lavaeon-x", ["hr-helper", "lavaeon"])).toBe(
      "lavaeon",
    );
  });
});
