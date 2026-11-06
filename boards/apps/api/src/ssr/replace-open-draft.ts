import { and, eq } from "drizzle-orm";
import type db from "../database";
import { ssrVersionTable } from "../database/ssr-schema";

type Writer = Pick<typeof db, "update">;

// The newer corpus replaces a draft in place only while it is still a draft
// (Q-015). The status check sits in the UPDATE itself: when an approval or
// rejection commits first, Postgres re-checks the row after the lock and the
// update touches nothing instead of rewriting bytes the owner decided on.
export async function replaceOpenDraft(
  executor: Writer,
  versionId: string,
  values: {
    blobSha: string;
    files: (typeof ssrVersionTable.$inferInsert)["files"];
    commitSha: string;
    createdBy: string;
  },
): Promise<boolean> {
  const rows = await executor
    .update(ssrVersionTable)
    .set({ ...values, createdAt: new Date() })
    .where(
      and(
        eq(ssrVersionTable.id, versionId),
        eq(ssrVersionTable.status, "draft"),
      ),
    )
    .returning({ id: ssrVersionTable.id });
  return rows.length > 0;
}
