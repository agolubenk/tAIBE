import { and, eq } from "drizzle-orm";
import db from "../database";
import { activityTable } from "../database/schema";

// TB-143: the stored text of a comment, for the restore of the markers a
// caller with a token read. The author check stays in updateComment.
export async function storedCommentContent(id: string) {
  const [row] = await db
    .select({ content: activityTable.content })
    .from(activityTable)
    .where(and(eq(activityTable.id, id), eq(activityTable.type, "comment")))
    .limit(1);
  return row?.content;
}
