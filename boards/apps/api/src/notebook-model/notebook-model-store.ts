import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import db, { schema } from "../database";
import { isHttpsUrl } from "../notebook/llm/base-url";

const SETTING_KEY = "notebook.model";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const MODEL_NAMES_MAX = 3;
export const CHAIN_POINTS_MAX = 4;

// OpenRouter's own fallbacks for one point (`models`), tried there in order.
const modelNames = z.array(z.string().min(1).max(200)).max(MODEL_NAMES_MAX);

// TB-159: a point after the main one. Its key is sealed to its own address.
export const storedModelPointSchema = z.object({
  id: z.string().min(1).max(64),
  baseUrl: z.string().url().refine(isHttpsUrl),
  model: z.string().min(1),
  models: modelNames.optional(),
  key: z.string().startsWith("enc:v1:").optional(),
});

export type StoredModelPoint = z.infer<typeof storedModelPointSchema>;

// Instance-wide (R-052, TB-67): one model key for every product on the
// server. Unset fields fall back to the server's environment.
export const storedNotebookModelSchema = z.object({
  baseUrl: z.string().url().refine(isHttpsUrl).optional(),
  model: z.string().min(1).optional(),
  models: modelNames.optional(),
  embedModel: z.string().min(1).optional(),
  dailyMax: z.number().int().min(0).optional(),
  // Sealed with the server's settings key, never plain.
  key: z.string().startsWith("enc:v1:").optional(),
  // In the admin's order: tried after the main point fails (R-053).
  chain: z.array(storedModelPointSchema).max(CHAIN_POINTS_MAX).optional(),
});

export type StoredNotebookModel = z.infer<typeof storedNotebookModelSchema>;

function parseChain(raw: unknown): StoredModelPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((point) => {
      const parsed = storedModelPointSchema.safeParse(point);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, CHAIN_POINTS_MAX);
}

// Field by field, and the chain point by point: a value that no longer passes
// is dropped on its own instead of taking the stored keys down with it.
function parseStored(raw: unknown): StoredNotebookModel {
  if (typeof raw !== "object" || raw === null) return {};
  const fields = Object.entries(storedNotebookModelSchema.shape).flatMap(
    ([name, check]) => {
      const value = (raw as Record<string, unknown>)[name];
      if (name === "chain") {
        const chain = parseChain(value);
        return chain.length ? [[name, chain]] : [];
      }
      const parsed = check.safeParse(value);
      return parsed.success && parsed.data !== undefined
        ? [[name, parsed.data]]
        : [];
    },
  );
  return storedNotebookModelSchema.parse(Object.fromEntries(fields));
}

export async function readStoredNotebookModel(
  executor: Executor = db,
): Promise<StoredNotebookModel> {
  const [row] = await executor
    .select({ value: schema.instanceSettingTable.value })
    .from(schema.instanceSettingTable)
    .where(eq(schema.instanceSettingTable.key, SETTING_KEY))
    .limit(1);
  if (!row) return {};
  try {
    return parseStored(JSON.parse(row.value));
  } catch {
    return {};
  }
}

// Held to the end of the transaction, so two admins saving at once do not
// overwrite each other's fields.
export async function lockStoredNotebookModel(executor: Executor) {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${SETTING_KEY}))`,
  );
}

export async function writeStoredNotebookModel(
  value: StoredNotebookModel,
  actorId: string | null,
  executor: Executor = db,
) {
  const text = JSON.stringify(storedNotebookModelSchema.parse(value));
  await executor
    .insert(schema.instanceSettingTable)
    .values({ key: SETTING_KEY, value: text, updatedBy: actorId })
    .onConflictDoUpdate({
      target: schema.instanceSettingTable.key,
      set: { value: text, updatedBy: actorId, updatedAt: new Date() },
    });
}
