import { inArray } from "drizzle-orm";
import db, { schema } from "../../../apps/api/src/database";

// Another write holding these cards (FOR UPDATE) until release() — the batch
// close meets them as «locked» after its lock wait.
export async function holdTaskLocks(ids: string[]) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let taken = () => {};
  const lockTaken = new Promise<void>((resolve) => {
    taken = resolve;
  });
  const holder = db.transaction(async (tx) => {
    await tx
      .select({ id: schema.taskTable.id })
      .from(schema.taskTable)
      .where(inArray(schema.taskTable.id, ids))
      .for("update");
    taken();
    await held;
  });
  await lockTaken;
  return async () => {
    release();
    await holder;
  };
}
