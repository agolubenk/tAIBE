import { DEFAULT_PLAN_PRODUCT } from "./plan-types";

// The product of a queue item by its id, by the rule of queue.match in
// instances/<slug>.json as the Nerve reads it (for_item): an item of a
// product carries "-<tag>-" in its id (d-taibe-hetty-1411, and older forms
// like s-restart-4-taibe-1211) or starts with "<product>-" (taibe-m-93, the
// console's own form). hr is the tag of the default product.
// The console's doc.product cannot tell: it reads only the start of the id
// (namespaceOf, infra/ops-console/server/queue/products.ts), so every
// d-taibe-… item comes as hr-helper there. null — no product of these in the
// id; the caller decides what that means.
// One rule for the board: the owner-queue view (TB-156) uses it now, the plan
// inputs (#162 itemProduct) move to it in TB-174.
export function productOfItemId(
  id: string,
  products: readonly string[],
): string | null {
  const tagOf = (product: string) =>
    product === DEFAULT_PLAN_PRODUCT ? "hr" : product;
  // Another product before the default one, a longer name first: d-taibe-hr-x
  // is a tAIBE item that mentions HR, not the other way round.
  const order = [...new Set(products)].sort(
    (a, b) =>
      Number(a === DEFAULT_PLAN_PRODUCT) - Number(b === DEFAULT_PLAN_PRODUCT) ||
      b.length - a.length,
  );
  return (
    order.find(
      (product) =>
        id.includes(`-${tagOf(product)}-`) || id.startsWith(`${product}-`),
    ) ?? null
  );
}
