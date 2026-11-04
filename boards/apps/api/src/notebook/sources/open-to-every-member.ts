import { sql } from "drizzle-orm";
import { projectTable, workspaceUserTable } from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";

// Threads and answers are shared by everyone who reads the workspace (R-041),
// so the notebook takes only what every member may open: the cards of such a
// project and the PRs of a repo linked to it. The query must join projectTable.
export const openToEveryMember = sql<boolean>`not exists (
  select 1 from ${workspaceUserTable} as reader
  where reader.workspace_id = ${projectTable.workspaceId}
    and not ${projectAccessCondition(sql`reader.user_id`, projectTable.id)}
)`;
