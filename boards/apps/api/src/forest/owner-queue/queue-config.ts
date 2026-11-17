import { readFileSync } from "node:fs";

export type OwnerQueueConfig = {
  // ops-console base, e.g. https://ops.admin.hrhelper.space
  url: string;
  tokenFile: string;
  // The token's author name in the queue journal, as the ops-console writes it:
  // «token:<name>» (server/queue/auth.ts). OQ_TOKEN_NAME may hold the bare name
  // or the full one (R-4, Q-3; TB-111). An event under another name is not
  // t-boards' own write.
  tokenName: string;
  // workspace id → queue product slug; a workspace not listed gets no items,
  // only the t-boards UI.
  products: Map<string, string>;
  plan: {
    // workspace id → plan product: whose rows w-<product>-* its cards belong
    // to (TB-106). Items keep the queue product: one token sees one queue
    // product, while the plan rows of several products live in it.
    products: Map<string, string>;
  };
};

// «<workspaceId>=<slug>,…»; a pair with a bad slug is dropped.
function workspacePairs(value: string | undefined): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const pair of (value ?? "").split(",")) {
    const [workspaceId, product] = pair.split("=").map((part) => part.trim());
    if (workspaceId && product && /^[a-z0-9-]{1,40}$/.test(product)) {
      pairs.set(workspaceId, product);
    }
  }
  return pairs;
}

// TB-102: the owner-queue sync is off unless the URL, the token file, its
// name and at least one workspace → product pair are set (AC-14). The token
// comes from a file only and is read on every call, so rotation needs no
// restart. OQ_PLAN_PRODUCTS (optional, TB-106) names the plan product of a
// mapped workspace; a workspace not listed there plans under its queue
// product.
export function readOwnerQueueConfig(
  env: NodeJS.ProcessEnv = process.env,
): OwnerQueueConfig | null {
  const url = env.OQ_URL?.trim().replace(/\/+$/, "");
  const tokenFile = env.OQ_TOKEN_FILE?.trim();
  const tokenName = env.OQ_TOKEN_NAME?.trim();
  const products = workspacePairs(env.OQ_WORKSPACE_PRODUCTS);
  if (!url || !tokenFile || !tokenName || products.size === 0) return null;
  const planned = workspacePairs(env.OQ_PLAN_PRODUCTS);
  const plan = new Map(
    [...products].map(([workspaceId, product]) => [
      workspaceId,
      planned.get(workspaceId) ?? product,
    ]),
  );
  return {
    url,
    tokenFile,
    tokenName: journalActor(tokenName),
    products,
    plan: { products: plan },
  };
}

// TB-111: the journal names a token's writes «token:<name>»; comparing with the
// bare name read every t-boards write as someone else's (queue_item_changed).
export function journalActor(tokenName: string): string {
  return tokenName.startsWith("token:") ? tokenName : `token:${tokenName}`;
}

export function readQueueToken(config: OwnerQueueConfig): string {
  const token = readFileSync(config.tokenFile, "utf8").trim();
  if (!token) throw new Error(`OQ_TOKEN_FILE is empty: ${config.tokenFile}`);
  return token;
}

// The queue tells a product by the id's prefix (F19): hr-helper has none,
// any other product is «<slug>-».
export function itemIdPrefix(product: string): string {
  return product === "hr-helper" ? "" : `${product}-`;
}
