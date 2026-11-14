import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import db, { schema } from "../database";
import { notebookMessageTable } from "../database/notebook-schema";

// D-018: a sum of one usage field over today's calls. bigint, because a day
// of a busy product can pass int4; the driver gives it as a string.
const usageSum = (field: "input" | "output" | "cached") =>
  sql<number>`coalesce(sum((${notebookMessageTable.usage}->>${field})::bigint), 0)`.mapWith(
    Number,
  );

// Today's model calls per product, so the admin sees who spends the shared
// daily limit. Only answers that called the model carry a model. Tokens are
// the provider's own counts (D-018); withUsage says over how many calls they
// are summed, because a provider may send no usage.
export async function usageByWorkspace() {
  const calls = sql<number>`count(*)::int`;
  return db
    .select({
      workspaceId: notebookMessageTable.workspaceId,
      name: schema.workspaceTable.name,
      calls,
      withUsage: sql<number>`count(${notebookMessageTable.usage})::int`,
      input: usageSum("input"),
      output: usageSum("output"),
      cached: usageSum("cached"),
    })
    .from(notebookMessageTable)
    .innerJoin(
      schema.workspaceTable,
      eq(schema.workspaceTable.id, notebookMessageTable.workspaceId),
    )
    .where(
      and(
        isNotNull(notebookMessageTable.model),
        sql`${notebookMessageTable.createdAt} >= date_trunc('day', now() AT TIME ZONE 'utc')`,
      ),
    )
    .groupBy(notebookMessageTable.workspaceId, schema.workspaceTable.name)
    .orderBy(desc(calls))
    .limit(100);
}
