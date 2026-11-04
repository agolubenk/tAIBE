import db from "../database";
import { workspaceTable } from "../database/schema";
import { pruneUnlinkedPullRequests } from "../notebook/sources/linked-repositories";
import { syncCardSources } from "../notebook/sources/sync-card-sources";
import { withJobLease } from "./leader-lock";

export const NOTEBOOK_CARD_SYNC_LEASE = "notebook-card-sync";

const WORKSPACES_MAX = 1000;

// One workspace failing must not stop the rest; the run reports degraded.
export async function syncNotebookCards() {
  return withJobLease(
    NOTEBOOK_CARD_SYNC_LEASE,
    async () => {
      const workspaces = await db
        .select({ id: workspaceTable.id })
        .from(workspaceTable)
        .limit(WORKSPACES_MAX);
      let degraded = false;
      for (const workspace of workspaces) {
        try {
          await syncCardSources(workspace.id);
          await pruneUnlinkedPullRequests(workspace.id);
        } catch (error) {
          degraded = true;
          console.error(
            `Notebook card sync failed for workspace ${workspace.id}`,
            error,
          );
        }
      }
      return { degraded };
    },
    () => ({ degraded: false }),
  );
}
