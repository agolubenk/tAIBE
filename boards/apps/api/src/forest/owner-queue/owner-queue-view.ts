import { HTTPException } from "hono/http-exception";
import type { ForestActor } from "../actor";
import { ForestError } from "../forest-error";
import { productOfItemId } from "./item-product";
import type {
  QueueClient,
  QueueDoc,
  QueueEvent,
  QueueFile,
  QueueFileReader,
} from "./queue-client";

// TB-156 (spec owner-queue-move §5.6): the owner's queue on the board, read
// only. Every doc comes from the ops-console API; the board keeps nothing but
// the last list body per view in memory, so search, the notebook and MCP never
// see queue docs.

export const OWNER_QUEUE_PAGE = 50;
export const OWNER_QUEUE_COLLECTIONS = ["items", "checks"] as const;
export type OwnerQueueCollection = (typeof OWNER_QUEUE_COLLECTIONS)[number];
export const OWNER_QUEUE_STATES = ["open", "answered", "all"] as const;
export type OwnerQueueState = (typeof OWNER_QUEUE_STATES)[number];

// Items hold the owner's private notes: agents, their keys and members get
// 403 on both routes.
export function assertOwnerQueueReader(actor: ForestActor) {
  if (actor.kind !== "owner-ui") {
    throw new ForestError(
      "owner_session_required",
      "only the owner's own session reads the owner queue",
    );
  }
}

type CachedList = {
  etag: string;
  docs: QueueDoc[];
  truncated: boolean;
  total: number | null;
};

const CACHE_MAX = 4;

// One body per (collection, open), revalidated with If-None-Match on every
// read: the console answers 304 while nothing changed. The console's tag
// follows the token's visibility, and the board has one token. A collection
// near the console's cap needs a windowed console method (TB-153), not a
// bigger cache.
export class OwnerQueueListCache {
  private readonly entries = new Map<string, CachedList>();

  async read(
    client: QueueClient,
    collection: OwnerQueueCollection,
    open: boolean,
  ): Promise<CachedList> {
    const key = `${collection}|${open ? "open" : "all"}`;
    const cached = this.entries.get(key);
    const page = await client.list(collection, 0, {
      open,
      ifNoneMatch: cached?.etag,
    });
    if (page.notModified && cached) {
      this.remember(key, cached);
      return cached;
    }
    const fresh: CachedList = {
      etag: page.etag ?? "",
      docs: page.docs,
      // The console reads the whole visible collection in one page; a next
      // page here means a capped answer all the same.
      truncated: page.truncated || page.nextOffset !== null,
      total: page.total ?? null,
    };
    if (fresh.etag) this.remember(key, fresh);
    return fresh;
  }

  private remember(key: string, value: CachedList) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > CACHE_MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : null;

// Open or done comes from the console's open list (?open=1); «again» shows
// only when the console sends a state of its own (TB-153).
export type OwnerQueueRowState = "open" | "done";

// A list row carries no body: 50 bodies of up to 12 KB would be 600 KB on a
// slow phone. The body, the history and the files come with the item.
// answer — the owner's answer: for an item from its check (checks/<id>), for
// a check from itself.
export function toOwnerQueueRow(
  doc: QueueDoc,
  openIds: Set<string> | null,
  answer: QueueDoc | null,
  product: string | null,
) {
  const data = doc.data;
  const inbox =
    data.inbox && typeof data.inbox === "object"
      ? (data.inbox as Record<string, unknown>)
      : null;
  const owner = answer?.data ?? {};
  const state: OwnerQueueRowState | null = openIds
    ? openIds.has(doc.id)
      ? "open"
      : "done"
    : null;
  return {
    id: doc.id,
    product,
    kind: text(data.kind),
    title: text(data.title) ?? text(inbox?.text)?.slice(0, 300) ?? doc.id,
    added: text(data.added),
    source: text(data.source),
    pr: typeof data.pr === "number" ? data.pr : null,
    inboxType: text(inbox?.type),
    state,
    choice: text(owner.choice),
    done: typeof owner.done === "boolean" ? owner.done : null,
    answeredAt: text(owner.at),
    updatedAt: doc.updatedAt,
  };
}

// Open items: oldest first, the console's own order on /queue (#154
// orderItems: added, then creation time, then id; the owner's request). An
// answered item, the whole list and the checks: the newest answer first.
export type OwnerQueueOrder = "oldest" | "newest";

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function oldestFirst(a: QueueDoc, b: QueueDoc) {
  const added = (doc: QueueDoc) =>
    typeof doc.data.added === "string" ? doc.data.added : "";
  const created = (doc: QueueDoc) =>
    positive(doc.createdAt) || positive(doc.updatedAt);
  return (
    compare(added(a), added(b)) ||
    created(a) - created(b) ||
    compare(a.id, b.id)
  );
}

// The owner's answer time (ownerAt, else at), else the last write.
function answeredAt(answer: QueueDoc | null, doc: QueueDoc) {
  const at = Date.parse(
    text(answer?.data.ownerAt) ?? text(answer?.data.at) ?? "",
  );
  return Number.isFinite(at) ? at : doc.updatedAt;
}

export type OwnerQueueListQuery = {
  collection: OwnerQueueCollection;
  state: OwnerQueueState;
  product?: string;
  page: number;
  // The board's products (OQ_WORKSPACE_PRODUCTS and OQ_PLAN_PRODUCTS): the
  // ones an item id may name (productOfItemId).
  knownProducts?: readonly string[];
};

export async function listOwnerQueue(
  client: QueueClient,
  cache: OwnerQueueListCache,
  { collection, state, product, page, knownProducts = [] }: OwnerQueueListQuery,
) {
  const items = collection === "items";
  // Three lists at most, each one console call that answers 304 while
  // nothing changed; no call per row.
  const [all, open, checks] = await Promise.all([
    cache.read(client, collection, false),
    // Open or answered is the console's rule (?open=1), never a copy of it.
    items ? cache.read(client, "items", true) : null,
    items ? cache.read(client, "checks", false) : null,
  ]);
  const openIds = open ? new Set(open.docs.map((doc) => doc.id)) : null;
  const answers = checks
    ? new Map(checks.docs.map((doc) => [doc.id, doc]))
    : null;
  // The product by the item id first (d-taibe-… comes as hr-helper from the
  // console), else the console's field.
  const named = [
    ...knownProducts,
    ...all.docs.flatMap((doc) => (doc.product ? [doc.product] : [])),
  ];
  const productOf = new Map(
    all.docs.map((doc) => [
      doc.id,
      productOfItemId(doc.id, named) ?? text(doc.product),
    ]),
  );
  const products = [
    ...new Set([...productOf.values()].filter((one) => one !== null)),
  ].sort();
  let docs = product
    ? all.docs.filter((doc) => productOf.get(doc.id) === product)
    : all.docs;
  if (openIds && state !== "all") {
    const wantOpen = state === "open";
    docs = docs.filter((doc) => openIds.has(doc.id) === wantOpen);
  }
  const order: OwnerQueueOrder =
    items && state === "open" ? "oldest" : "newest";
  const answerOf = (doc: QueueDoc) =>
    answers ? (answers.get(doc.id) ?? null) : doc;
  docs = [...docs].sort(
    order === "oldest"
      ? oldestFirst
      : (a, b) =>
          answeredAt(answerOf(b), b) - answeredAt(answerOf(a), a) ||
          compare(a.id, b.id),
  );
  const start = (page - 1) * OWNER_QUEUE_PAGE;
  return {
    docs: docs
      .slice(start, start + OWNER_QUEUE_PAGE)
      .map((doc) =>
        toOwnerQueueRow(
          doc,
          openIds,
          answerOf(doc),
          productOf.get(doc.id) ?? null,
        ),
      ),
    page,
    pageSize: OWNER_QUEUE_PAGE,
    order,
    total: docs.length,
    products,
    truncated: all.truncated,
    // A capped console list: how many docs the collection has in all.
    collectionTotal: all.truncated ? all.total : null,
  };
}

export type OwnerQueueDocView = {
  doc: QueueDoc;
  check: QueueDoc | null;
  history: QueueEvent[];
  checkHistory: QueueEvent[];
  files: QueueFile[];
};

export async function readOwnerQueueDoc(
  client: QueueClient & QueueFileReader,
  collection: OwnerQueueCollection,
  id: string,
): Promise<OwnerQueueDocView> {
  const doc = await client.get(collection, id);
  if (!doc) {
    throw new HTTPException(404, {
      message: "owner_queue_not_found: no such queue document",
    });
  }
  const item = collection === "items";
  // checks/<id> is the owner's answer to items/<id> (ops-console list.ts).
  const [history, check, checkHistory, files] = await Promise.all([
    client.history(collection, id),
    item ? client.get("checks", id) : Promise.resolve(null),
    item ? client.history("checks", id) : Promise.resolve<QueueEvent[]>([]),
    // Only inbox items carry files (ops-console GET /files?item=).
    item && doc.data.kind === "inbox"
      ? client.files(id)
      : Promise.resolve<QueueFile[]>([]),
  ]);
  return { doc, check, history, checkHistory, files };
}
