import { eq, sql } from "drizzle-orm";
import db from "../../database";
import {
  notebookChunkTable,
  notebookSourceTable,
} from "../../database/notebook-schema";
import { isWorkerOnline, workerLastSeen } from "../embed/embed-queue";
import { cloudCallsToday } from "../chat/call-budget";
import { effectiveNotebookModel } from "../../notebook-model/effective-notebook-model";
import { indexedChunks } from "../search/vector-index";

export async function notebookStatus(workspaceId: string) {
  const [settings, callsToday] = await Promise.all([
    effectiveNotebookModel(),
    cloudCallsToday(),
  ]);
  const model = settings.embedModel;
  const [[sources], [chunks]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(notebookSourceTable)
      .where(eq(notebookSourceTable.workspaceId, workspaceId)),
    db
      .select({
        count: sql<number>`count(*)::int`,
        embedded: sql<number>`count(*) filter (where ${notebookChunkTable.embedModel} = ${model} and ${notebookChunkTable.embedding} is not null)::int`,
        width: sql<number>`coalesce(max(octet_length(${notebookChunkTable.embedding})) filter (where ${notebookChunkTable.embedModel} = ${model}), 0)::int`,
      })
      .from(notebookChunkTable)
      .where(eq(notebookChunkTable.workspaceId, workspaceId)),
  ]);
  const seen = workerLastSeen(workspaceId);
  return {
    model,
    workerOnline: isWorkerOnline(workspaceId),
    workerSeenAt: seen === null ? null : new Date(seen),
    sources: sources?.count ?? 0,
    chunks: chunks?.count ?? 0,
    embedded: chunks?.embedded ?? 0,
    indexed: indexedChunks(chunks?.embedded ?? 0, chunks?.width ?? 0),
    llm: {
      configured: settings.model !== null && settings.key !== null,
      model: settings.model,
      callsToday,
      dailyMax: settings.model ? settings.dailyMax : null,
    },
  };
}
