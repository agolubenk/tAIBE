import { and, desc, eq, inArray } from "drizzle-orm";
import db from "../../database";
import { sectorTable, sectorTreeTable } from "../../database/forest-schema";
import { sectorName } from "../sector/sector-name";
import { PAGE_MAX } from "./page-cursor";

export async function listSectors(workspaceId: string, status = "active") {
  const sectors = await db
    .select({
      id: sectorTable.id,
      name: sectorTable.name,
      detectedBy: sectorTable.detectedBy,
      status: sectorTable.status,
      fellingId: sectorTable.fellingId,
      createdAt: sectorTable.createdAt,
    })
    .from(sectorTable)
    .where(
      and(
        eq(sectorTable.workspaceId, workspaceId),
        eq(sectorTable.status, status),
      ),
    )
    .orderBy(desc(sectorTable.createdAt))
    .limit(PAGE_MAX);
  const trees = sectors.length
    ? await db
        .select({
          sectorId: sectorTreeTable.sectorId,
          taskId: sectorTreeTable.taskId,
        })
        .from(sectorTreeTable)
        .where(
          inArray(
            sectorTreeTable.sectorId,
            sectors.map((sector) => sector.id),
          ),
        )
    : [];
  return sectors.map((sector) => ({
    ...sector,
    name: sectorName(sector.name),
    treeIds: trees
      .filter((tree) => tree.sectorId === sector.id)
      .map((tree) => tree.taskId),
  }));
}
