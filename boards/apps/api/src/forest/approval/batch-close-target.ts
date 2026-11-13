import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  cardMetaTable,
  ownerApprovalTable,
} from "../../database/forest-schema";
import { columnTable, projectTable, taskTable } from "../../database/schema";
import { assertProjectAccess } from "../../project-access/assert-project-access";
import {
  BATCH_CLOSE_MAX,
  type BatchCard,
  batchCloseItems,
  batchCloseParams,
  finalTarget,
  isClosed,
  UNSAFE_SLUG,
} from "./batch-close-params";
import { splitIds } from "./grant-items";

// Ids of these cards already in a pending close request of this workspace
// (R-4: one request per card at a time). Only the requests that name one of
// the ids are read, so no unrelated request is cut off by a limit.
async function pendingCloseIds(
  workspaceId: string,
  ids: string[],
): Promise<Set<string>> {
  const asked = sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
  const rows = await db
    .select({
      targetType: ownerApprovalTable.targetType,
      targetId: ownerApprovalTable.targetId,
      params: ownerApprovalTable.params,
    })
    .from(ownerApprovalTable)
    .where(
      and(
        eq(ownerApprovalTable.workspaceId, workspaceId),
        eq(ownerApprovalTable.status, "pending"),
        eq(ownerApprovalTable.action, "close_task"),
        gte(ownerApprovalTable.expiresAt, new Date()),
        or(
          inArray(ownerApprovalTable.targetId, ids),
          sql`string_to_array(${ownerApprovalTable.params}->>'taskIds', ',') && ${asked}`,
        ),
      ),
    )
    .limit(BATCH_CLOSE_MAX);
  const wanted = new Set(ids);
  const found = new Set<string>();
  for (const row of rows) {
    if (row.targetType === "task" && wanted.has(row.targetId)) {
      found.add(row.targetId);
    }
    for (const id of splitIds(row.params?.taskIds)) {
      if (wanted.has(id)) found.add(id);
    }
  }
  return found;
}

function refusal(problems: Map<string, string[]>): HTTPException {
  const parts = [...problems].map(([reason, keys]) => {
    const shown = keys.slice(0, 10).join(", ");
    const more = keys.length > 10 ? ` (+${keys.length - 10})` : "";
    return `${reason}: ${shown}${more}`;
  });
  return new HTTPException(400, {
    message:
      `batch close_task refused — drop these cards and ask again; ${parts.join("; ")}`.slice(
        0,
        1000,
      ),
  });
}

// TB-108 R-1, R-2, R-4: checks every card and fixes what one «да» will do.
// Any card that cannot be in the request refuses the whole request, with the
// reason per card; nothing is stored.
export async function batchCloseTarget(
  workspaceId: string,
  userId: string,
  body: { targetId: string; value?: string; taskIds?: string[] },
): Promise<{
  targetType: "workspace";
  items: string[];
  params: Record<string, string>;
}> {
  if (body.targetId !== workspaceId) {
    throw new HTTPException(400, {
      message: "close_task with taskIds: targetId is the workspace id",
    });
  }
  if (body.value) {
    throw new HTTPException(400, {
      message:
        "close_task with taskIds takes no value: each card goes to its project's final column",
    });
  }
  const ids = [...new Set(body.taskIds ?? [])];
  if (ids.length === 0 || ids.length > BATCH_CLOSE_MAX) {
    throw new HTTPException(400, {
      message: `close_task with taskIds: 1 to ${BATCH_CLOSE_MAX} cards`,
    });
  }

  const rows = await db
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      status: taskTable.status,
      number: taskTable.number,
      slug: projectTable.slug,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(inArray(taskTable.id, ids));
  const byId = new Map(
    rows
      .filter((row) => row.workspaceId === workspaceId)
      .map((row) => [row.id, row]),
  );
  const projectIds = [...new Set([...byId.values()].map((r) => r.projectId))];
  if (projectIds.length > 0) await assertProjectAccess(userId, projectIds);

  const columns = projectIds.length
    ? await db
        .select({
          projectId: columnTable.projectId,
          slug: columnTable.slug,
          isFinal: columnTable.isFinal,
          position: columnTable.position,
        })
        .from(columnTable)
        .where(inArray(columnTable.projectId, projectIds))
    : [];
  const columnsOf = (projectId: string) =>
    columns.filter((column) => column.projectId === projectId);
  const halfBaked = new Set(
    (
      await db
        .select({ taskId: cardMetaTable.taskId })
        .from(cardMetaTable)
        .where(
          and(
            inArray(cardMetaTable.taskId, ids),
            eq(cardMetaTable.halfBaked, true),
          ),
        )
    ).map((row) => row.taskId),
  );
  const pending = await pendingCloseIds(workspaceId, ids);

  const problems = new Map<string, string[]>();
  const refuse = (reason: string, key: string) =>
    problems.set(reason, [...(problems.get(reason) ?? []), key]);
  const targets = new Map<string, string>();
  const cards: BatchCard[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      refuse("not_found", id);
      continue;
    }
    const key = `${row.slug}-${row.number ?? "?"}`;
    const projectColumns = columnsOf(row.projectId);
    const target = finalTarget(projectColumns);
    if (!target || UNSAFE_SLUG.test(target) || UNSAFE_SLUG.test(key)) {
      refuse("no_final_column", key);
    } else if (UNSAFE_SLUG.test(row.status)) {
      refuse("unsafe_status", key);
    } else if (isClosed(projectColumns, row.status)) {
      refuse("already_closed", key);
    } else if (halfBaked.has(id)) {
      refuse("half_baked", key);
    } else if (pending.has(id)) {
      refuse("approval_pending", key);
    } else {
      targets.set(row.projectId, target);
      cards.push({ id, projectId: row.projectId, from: row.status, key });
    }
  }
  if (problems.size > 0) throw refusal(problems);

  cards.sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
  const batch = { cards, targets };
  return {
    targetType: "workspace",
    items: batchCloseItems(batch),
    params: batchCloseParams(batch),
  };
}
