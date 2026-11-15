import { eq } from "drizzle-orm";
import type { Context } from "hono";
import db from "../database";
import { taskTable } from "../database/schema";
import { restoreForTokenCaller } from "../utils/token-caller-text";

type TaskText = { title?: string; description?: string };

// TB-143: a write that replaces a task's title or description gets the
// stored values back in place of the markers a caller with a token read.
// The stored row is read once, and only if a field carries a marker.
export async function restoreTaskText<T extends TaskText>(
  c: Context,
  id: string,
  text: T,
): Promise<T> {
  let stored: Promise<TaskText | undefined> | undefined;
  const load = () =>
    (stored ??= db
      .select({ title: taskTable.title, description: taskTable.description })
      .from(taskTable)
      .where(eq(taskTable.id, id))
      .limit(1)
      .then(([row]) =>
        row
          ? { title: row.title, description: row.description ?? undefined }
          : undefined,
      ));

  const restored: TaskText = { ...text };
  if (text.title !== undefined) {
    restored.title = await restoreForTokenCaller(
      c,
      text.title,
      async () => (await load())?.title,
    );
  }
  if (text.description !== undefined) {
    restored.description = await restoreForTokenCaller(
      c,
      text.description,
      async () => (await load())?.description,
    );
  }
  return restored as T;
}
