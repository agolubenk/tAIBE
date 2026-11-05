import { eq } from "drizzle-orm";
import db from "../database";
import { workspaceTable } from "../database/schema";
import {
  type ApiKeyWorkspaceScope,
  scopeAllowsWorkspace,
} from "../utils/api-key-workspace-scope";
import listWorkspaces from "../workspace/controllers/list-workspaces";

// Workspaces whose approved versions may vouch for a draft: the ones the user
// can read (the same list the workspace switcher shows), narrowed by a
// workspace-scoped key, plus the workspace the route already authorized.
// Anything outside this map is never queried, so it cannot leak.
export async function readableWorkspaces(
  userId: string,
  scope: ApiKeyWorkspaceScope | undefined,
  workspaceId: string,
): Promise<Map<string, string>> {
  const readable = new Map<string, string>();
  for (const workspace of await listWorkspaces(userId)) {
    if (scopeAllowsWorkspace(scope, workspace.id)) {
      readable.set(workspace.id, workspace.name);
    }
  }
  if (!readable.has(workspaceId)) {
    const [current] = await db
      .select({ name: workspaceTable.name })
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId))
      .limit(1);
    readable.set(workspaceId, current?.name ?? "");
  }
  return readable;
}
