import type { ImportedProject } from "@kaneo/importers";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import { chunk } from "../writer/chunk";
import { backlogIdOf } from "./notion-card-meta";
import { footerOf, withNotionFooter } from "./notion-footer";
import { type BacklogGroup, resolveBacklogIds } from "./resolve-backlog-ids";

export type PreparedNotionProject = {
  project: ImportedProject;
  // Keys of pages whose Backlog ID stays in the footer only.
  backlogDropped: Set<string>;
  backlogGroups: BacklogGroup[];
};

// Settles who holds each Backlog ID, then gives every page its footer.
// Under force every repeat is settled afresh; a normal pass leaves an ID with
// the card that holds it, since moving it would rewrite a page not re-read.
export async function prepareNotionProject(
  workspaceId: string,
  project: ImportedProject,
  force: boolean,
): Promise<PreparedNotionProject> {
  const candidates = project.tasks.flatMap((task) =>
    task.sourceRef
      ? [
          {
            key: task.key,
            pageId: task.sourceRef.pageId,
            createdTime: task.sourceRef.createdTime ?? "",
            backlogId: backlogIdOf(task),
          },
        ]
      : [],
  );
  const pageIds = new Set(candidates.map(({ pageId }) => pageId));
  const values = [
    ...new Set(candidates.flatMap(({ backlogId }) => backlogId ?? [])),
  ];

  const outside = new Set<string>();
  const byPage = new Map<string, string>();
  for (const batch of chunk(values)) {
    const rows = await db
      .select({
        backlogId: cardMetaTable.backlogId,
        notionPageId: cardMetaTable.notionPageId,
      })
      .from(cardMetaTable)
      .where(
        and(
          eq(cardMetaTable.workspaceId, workspaceId),
          isNotNull(cardMetaTable.backlogId),
          inArray(cardMetaTable.backlogId, batch),
        ),
      );
    for (const { backlogId, notionPageId } of rows) {
      if (backlogId === null) continue;
      if (notionPageId && pageIds.has(notionPageId)) {
        if (!force) byPage.set(backlogId, notionPageId);
      } else outside.add(backlogId);
    }
  }

  const { dropped, groups } = resolveBacklogIds(candidates, {
    outside,
    byPage,
  });
  return {
    project: {
      ...project,
      tasks: project.tasks.map((task) =>
        task.sourceRef
          ? {
              ...task,
              description: withNotionFooter(
                task.description,
                footerOf(task, !dropped.has(task.key)),
              ),
            }
          : task,
      ),
    },
    backlogDropped: dropped,
    backlogGroups: groups,
  };
}
