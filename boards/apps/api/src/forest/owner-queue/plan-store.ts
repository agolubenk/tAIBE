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

// F8: cards of the mapped workspaces that moved to in-progress or in-review,
// or closed, since the given time.
async function recent(products: Map<string, string>, since: Date) {
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
        or(
          and(
            inArray(taskTable.status, [...ACTIVE_STATUSES]),
            gte(taskTable.updatedAt, since),
          ),
          and(
            eq(columnTable.isFinal, true),
            or(
              gte(taskTable.completedAt, since),
              and(
                isNull(taskTable.completedAt),
                gte(taskTable.updatedAt, since),
              ),
            ),
          ),
        ),
      ),
    )
    .orderBy(desc(taskTable.updatedAt))
    .limit(RECENT_MAX);
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

export const planStore: PlanStore = { resolve, recent, abandoned };
