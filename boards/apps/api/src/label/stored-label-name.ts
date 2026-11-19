import { eq } from "drizzle-orm";
import db from "../database";
import { labelTable } from "../database/schema";

// TB-144: the stored name a masked label name is restored against.
export async function storedLabelName(id: string) {
  const [row] = await db
    .select({ name: labelTable.name })
    .from(labelTable)
    .where(eq(labelTable.id, id))
    .limit(1);
  return row?.name;
}
