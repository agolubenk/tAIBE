import { and, eq } from "drizzle-orm";
import db from "../../database";
import { columnTable } from "../../database/schema";
import { OWNER_STAGE_SLUGS } from "../../project/project-processes";

type Reader = Pick<typeof db, "select">;

// A status closes a card when its column is final («готово»), or when it is
// the virtual «archived», which hides the card the same way (R-022). The
// owner's stage past review («Подтверждение») counts as closing too: an agent
// stops at «На ревью» and goes further, or back out, only with the owner's
// «да» (owner, 29.10).
export function closesAt(status: string, isFinal: boolean): boolean {
  return isFinal || status === "archived" || OWNER_STAGE_SLUGS.has(status);
}

export async function isClosingStatus(
  projectId: string,
  status: string,
  reader: Reader = db,
): Promise<boolean> {
  if (closesAt(status, false)) return true;
  const [column] = await reader
    .select({ isFinal: columnTable.isFinal })
    .from(columnTable)
    .where(
      and(eq(columnTable.projectId, projectId), eq(columnTable.slug, status)),
    )
    .limit(1);
  return column?.isFinal ?? false;
}
