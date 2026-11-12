import { readFileSync } from "node:fs";

export type OwnerQueueConfig = {
  // ops-console base, e.g. https://ops.admin.hrhelper.space
  url: string;
  tokenFile: string;
  // The token's name in the queue, set by the owner when issuing it (R-4,
  // Q-3): an event under another name is not t-boards' own write.
  tokenName: string;
  // workspace id → queue product slug; a workspace not listed gets no items,
  // only the t-boards UI.
  products: Map<string, string>;
};

// TB-102: the owner-queue sync is off unless the URL, the token file, its
// name and at least one workspace → product pair are set (AC-14). The token
// comes from a file only and is read on every call, so rotation needs no
// restart.
export function readOwnerQueueConfig(
  env: NodeJS.ProcessEnv = process.env,
): OwnerQueueConfig | null {
  const url = env.OQ_URL?.trim().replace(/\/+$/, "");
  const tokenFile = env.OQ_TOKEN_FILE?.trim();
  const tokenName = env.OQ_TOKEN_NAME?.trim();
  const products = new Map<string, string>();
  for (const pair of (env.OQ_WORKSPACE_PRODUCTS ?? "").split(",")) {
    const [workspaceId, product] = pair.split("=").map((part) => part.trim());
    if (workspaceId && product && /^[a-z0-9-]{1,40}$/.test(product)) {
      products.set(workspaceId, product);
    }
  }
  if (!url || !tokenFile || !tokenName || products.size === 0) return null;
  return { url, tokenFile, tokenName, products };
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
