import { hasRedactionMarker } from "@kaneo/redact/restore";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import db from "../database";
import {
  customFieldDefinitionTable,
  customFieldValueTable,
} from "../database/schema";
import {
  isTokenCaller,
  restoreEachForTokenCaller,
  restoreForTokenCaller,
} from "../utils/token-caller-text";
import { isChoiceType, readOptions } from "./choice-options";
import { restoreChoiceValue } from "./restore-choice-value";
import type { CustomFieldUpdateInput } from "./resolve-field-update";

// TB-144: a caller with a token reads custom-field text masked where a task
// read masks it. A write-back gets the stored values back in place of the
// markers. The stored row is read only if a value carries a marker.

export async function restoreFieldValue(
  c: Context,
  taskId: string,
  fieldId: string,
  value: string,
): Promise<string> {
  if (!isTokenCaller(c) || !hasRedactionMarker(value)) return value;
  const [row] = await db
    .select({
      type: customFieldDefinitionTable.type,
      options: customFieldDefinitionTable.options,
      value: customFieldValueTable.value,
    })
    .from(customFieldDefinitionTable)
    .leftJoin(
      customFieldValueTable,
      and(
        eq(customFieldValueTable.fieldId, customFieldDefinitionTable.id),
        eq(customFieldValueTable.taskId, taskId),
      ),
    )
    .where(eq(customFieldDefinitionTable.id, fieldId))
    .limit(1);
  // TB-178: a choice value names options, which the caller reads masked too.
  if (row && isChoiceType(row.type) && Array.isArray(row.options)) {
    return restoreChoiceValue(
      value,
      row.type,
      readOptions(row.options),
      row.value,
    );
  }
  return restoreForTokenCaller(c, value, async () => row?.value);
}

type StoredField = {
  name: string;
  defaultValue: string | null;
  options: unknown;
};

export async function restoreFieldUpdate(
  c: Context,
  id: string,
  input: CustomFieldUpdateInput,
): Promise<CustomFieldUpdateInput> {
  let stored: Promise<StoredField | undefined> | undefined;
  const load = () =>
    (stored ??= db
      .select({
        name: customFieldDefinitionTable.name,
        defaultValue: customFieldDefinitionTable.defaultValue,
        options: customFieldDefinitionTable.options,
      })
      .from(customFieldDefinitionTable)
      .where(eq(customFieldDefinitionTable.id, id))
      .limit(1)
      .then(([row]) => row));

  const restored: CustomFieldUpdateInput = { ...input };
  if (input.name !== undefined) {
    restored.name = await restoreForTokenCaller(
      c,
      input.name,
      async () => (await load())?.name,
    );
  }
  if (typeof input.defaultValue === "string") {
    restored.defaultValue = await restoreForTokenCaller(
      c,
      input.defaultValue,
      async () => (await load())?.defaultValue,
    );
  }
  if (input.options !== undefined) {
    restored.options = await restoreEachForTokenCaller(
      c,
      input.options,
      async () => readOptions((await load())?.options),
    );
  }
  return restored;
}
