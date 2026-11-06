import { inArray, sql } from "drizzle-orm";
import db from "../database";
import {
  ssrBlobTable,
  ssrEntityTable,
  ssrVersionTable,
} from "../database/ssr-schema";

// Blobs are shared by all workspaces (RU-3 dedup), so a bare blob lookup
// tells a caller what another workspace stores (TB-86). A sha is known here
// only when a version of this workspace references it and its blob exists.
// A sha that only another workspace holds reads as unknown: the sync agent
// uploads the bytes, and the sync keeps the one stored blob.
export async function knownShas(
  workspaceId: string,
  shas: string[],
): Promise<string[]> {
  if (shas.length === 0) return [];
  const { rows } = await db.execute<{ sha256: string }>(sql`
    select distinct ${ssrBlobTable.sha256} as sha256
    from ${ssrEntityTable}
    join ${ssrVersionTable} on ${ssrVersionTable.entityId} = ${ssrEntityTable.id}
    cross join lateral jsonb_array_elements(${ssrVersionTable.files}) as file
    join ${ssrBlobTable} on ${ssrBlobTable.sha256} = file ->> 'sha256'
    where ${ssrEntityTable.workspaceId} = ${workspaceId}
      and ${inArray(ssrBlobTable.sha256, shas)}
  `);
  return rows.map((row) => row.sha256);
}
