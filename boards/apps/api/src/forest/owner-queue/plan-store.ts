import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import db from "../../database";
import { cardMetaTable, taskLeaseTable } from "../../database/forest-schema";
import {
  columnTable,
  projectTable,
  taskTable,
  workspaceTable,
} from "../../database/schema";
import type { PlanStore } from "./plan-pass";
import {
  ACTIVE_STATUSES,
  type BoardCard,
  type CardRef,
  cardUid,
  type RecentCard,
} from "./plan-types";

const RECENT_MAX = 300;
const NAMED_MAX = 200;
const ABANDONED_MAX = 1000;
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
// The page takes an upper-case key only (CARD_KEY in the queue page).
const PAGE_KEY = /^[A-Z][A-Z0-9]{0,15}-\d{1,7}$/;
const PRIORITY: Record<string, string> = {
  urgent: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
};

// The card's column joins by slug, as the board places a card (card-place.ts).
const cardColumn = () =>
  and(
    eq(columnTable.projectId, taskTable.projectId),
    eq(columnTable.slug, taskTable.status),
  );

type CardRow = {
  status: string;
  isFinal: boolean | null;
  completedAt: Date | null;
  updatedAt: Date;
};

// «archived» hides a card the way a final column does (R-022).
function boardCard(row: CardRow): BoardCard {
  const final = row.status === "archived" || row.isFinal === true;
  return {
    status: row.status,
    final,
    closedAt: final ? (row.completedAt ?? row.updatedAt) : null,
  };
}

function splitKey(key: string) {
  const at = key.lastIndexOf("-");
  return {
    slug: key.slice(0, at).toLowerCase(),
    number: Number(key.slice(at + 1)),
  };
}

// F4: the row cards in one query; a card of a workspace outside
// OQ_WORKSPACE_PRODUCTS is never read. A live project wins over an archived
// one with the same key.
async function resolve(workspaceIds: string[], refs: CardRef[]) {
  const board = new Map<string, BoardCard>();
  if (workspaceIds.length === 0 || refs.length === 0) return board;
  const keys = refs.map((ref) => splitKey(ref.key));
  const wanted = new Set(refs.map((ref) => cardUid(ref.ws, ref.key)));
  const rows = await db
    .select({
      ws: workspaceTable.slug,
      slug: projectTable.slug,
      number: taskTable.number,
      archivedAt: projectTable.archivedAt,
      status: taskTable.status,
      isFinal: columnTable.isFinal,
      completedAt: taskTable.completedAt,
      updatedAt: taskTable.updatedAt,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .innerJoin(workspaceTable, eq(projectTable.workspaceId, workspaceTable.id))
    .leftJoin(columnTable, cardColumn())
    .where(
      and(
        inArray(projectTable.workspaceId, workspaceIds),
        inArray(taskTable.number, [...new Set(keys.map((key) => key.number))]),
        inArray(sql`lower(${projectTable.slug})`, [
          ...new Set(keys.map((key) => key.slug)),
        ]),
      ),
    )
    .orderBy(sql`${projectTable.archivedAt} is null`);
  // Archived projects come first, so a live one overwrites them.
  for (const row of rows) {
    const uid = cardUid(row.ws, `${row.slug}-${row.number}`);
    if (wanted.has(uid)) board.set(uid, boardCard(row));
  }
  return board;
}

// Cards of the mapped workspaces in the row format, with their plan product.
async function productCards(
  products: Map<string, string>,
  where: SQL | undefined,
  limit: number,
): Promise<RecentCard[]> {
  const workspaceIds = [...products.keys()];
  if (workspaceIds.length === 0) return [];
  const rows = await db
    .select({
      workspaceId: projectTable.workspaceId,
      ws: workspaceTable.slug,
      slug: projectTable.slug,
      number: taskTable.number,
      title: taskTable.title,
      priority: taskTable.priority,
      status: taskTable.status,
      isFinal: columnTable.isFinal,
      completedAt: taskTable.completedAt,
      updatedAt: taskTable.updatedAt,
      kind: cardMetaTable.kind,
      severity: cardMetaTable.severity,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .innerJoin(workspaceTable, eq(projectTable.workspaceId, workspaceTable.id))
    .leftJoin(columnTable, cardColumn())
    .leftJoin(cardMetaTable, eq(cardMetaTable.taskId, taskTable.id))
    .where(
      and(
        inArray(projectTable.workspaceId, workspaceIds),
        isNull(projectTable.archivedAt),
        where,
      ),
    )
    .orderBy(desc(taskTable.updatedAt))
    .limit(limit);
  const cards: RecentCard[] = [];
  for (const row of rows) {
    const key = `${row.slug.toUpperCase()}-${row.number}`;
    const product = products.get(row.workspaceId);
    if (!product || !PAGE_KEY.test(key)) continue;
    const bug = row.kind === "bug";
    cards.push({
      ...boardCard(row),
      ws: row.ws,
      key,
      product,
      title: row.title,
      bug,
      level: (bug ? row.severity : PRIORITY[row.priority]) ?? "",
    });
  }
  return cards;
}

// F8: cards of the mapped workspaces that moved to in-progress or in-review,
// or closed, since the given time.
function recent(products: Map<string, string>, since: Date) {
  return productCards(
    products,
    or(
      and(
        inArray(taskTable.status, [...ACTIVE_STATUSES]),
        gte(taskTable.updatedAt, since),
      ),
      and(
        eq(columnTable.isFinal, true),
        or(
          gte(taskTable.completedAt, since),
          and(isNull(taskTable.completedAt), gte(taskTable.updatedAt, since)),
        ),
      ),
    ),
    RECENT_MAX,
  );
}

// TB-107: the cards the owner named, by key, in one query; a key that no
// mapped workspace has is dropped.
function named(products: Map<string, string>, keys: string[]) {
  const parts = keys.slice(0, NAMED_MAX).map(splitKey);
  if (parts.length === 0) return Promise.resolve([]);
  return productCards(
    products,
    and(
      inArray(taskTable.number, [...new Set(parts.map((key) => key.number))]),
      inArray(sql`lower(${projectTable.slug})`, [
        ...new Set(parts.map((key) => key.slug)),
      ]),
    ),
    NAMED_MAX * 2,
  ).then((cards) => {
    const wanted = new Set(keys.map((key) => key.toUpperCase()));
    return cards.filter((card) => wanted.has(card.key));
  });
}

// F9 in one query: cards in in-progress without a live lease (none, or
// expired) and without an update for 24 h.
async function abandoned(workspaceIds: string[], now: Date) {
  if (workspaceIds.length === 0) return new Set<string>();
  const rows = await db
    .select({
      ws: workspaceTable.slug,
      slug: projectTable.slug,
      number: taskTable.number,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .innerJoin(workspaceTable, eq(projectTable.workspaceId, workspaceTable.id))
    .leftJoin(
      taskLeaseTable,
      and(
        eq(taskLeaseTable.taskId, taskTable.id),
        gt(taskLeaseTable.expiresAt, now),
      ),
    )
    .where(
      and(
        inArray(projectTable.workspaceId, workspaceIds),
        isNull(projectTable.archivedAt),
        eq(taskTable.status, "in-progress"),
        isNull(taskLeaseTable.taskId),
        lt(taskTable.updatedAt, new Date(now.getTime() - ABANDONED_AFTER_MS)),
      ),
    )
    .limit(ABANDONED_MAX);
  return new Set(
    rows.map((row) => cardUid(row.ws, `${row.slug}-${row.number}`)),
  );
}

// TB-112 pace in one query: cards of each mapped workspace that entered a
// final column (or «archived») since then. A card closed, reopened and closed
// again is one row, so it counts once; its date is the last close.
async function closed(products: Map<string, string>, since: Date) {
  const perProduct = new Map<string, number>();
  const workspaceIds = [...products.keys()];
  if (workspaceIds.length === 0) return perProduct;
  const rows = await db
    .select({
      workspaceId: projectTable.workspaceId,
      count: sql<number>`count(distinct ${taskTable.id})`.mapWith(Number),
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .leftJoin(columnTable, cardColumn())
    .where(
      and(
        inArray(projectTable.workspaceId, workspaceIds),
        gte(taskTable.completedAt, since),
        or(eq(columnTable.isFinal, true), eq(taskTable.status, "archived")),
      ),
    )
    .groupBy(projectTable.workspaceId);
  for (const row of rows) {
    const product = products.get(row.workspaceId);
    if (!product) continue;
    perProduct.set(product, (perProduct.get(product) ?? 0) + row.count);
  }
  return perProduct;
}

export const planStore: PlanStore = {
  resolve,
  recent,
  named,
  abandoned,
  closed,
};
