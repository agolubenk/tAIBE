import { isDeepStrictEqual } from "node:util";

export type FieldChange = { from: unknown; to: unknown };
export type HistoryChanges = Record<string, FieldChange>;

export type RollbackDecision =
  | { ok: true; restore: Record<string, unknown> }
  | { ok: false; reason: string };

// A rollback undoes one edit: each field it changed goes back to the value
// before it. A field changed again since is a conflict, so a rollback never
// drops a later edit; undo that one first. `fixed` names fields this path
// cannot restore, with the reason.
export function decideRollback(
  changes: HistoryChanges,
  current: Record<string, unknown>,
  fixed: Record<string, string> = {},
): RollbackDecision {
  const fields = Object.keys(changes);
  const blocked = fields.find((field) => field in fixed);
  if (blocked) return { ok: false, reason: `${blocked}: ${fixed[blocked]}` };
  const changedAgain = fields.filter(
    (field) => !isDeepStrictEqual(current[field], changes[field]?.to),
  );
  if (changedAgain.length > 0) {
    return {
      ok: false,
      reason: `changed again since: ${changedAgain.join(", ")}; roll back the later edit first`,
    };
  }
  return {
    ok: true,
    restore: Object.fromEntries(
      fields.map((field) => [field, changes[field]?.from]),
    ),
  };
}

// The fields a move to a work stage fills in when they are empty
// (card-fill/fill-card.ts).
export const AUTOFILL_FIELDS: ReadonlySet<string> = new Set([
  "assigneeId",
  "startDate",
]);

// An agent's move and the autofill it caused are one action for the owner
// (R-023 AC-009, TB-69): an autofilled field that still holds the filled value
// goes back with the edit; a field someone changed since stays as it is.
export function withAutofill(
  edit: HistoryChanges,
  autofill: HistoryChanges | undefined,
  current: Record<string, unknown>,
): HistoryChanges {
  if (!autofill) return edit;
  const merged: HistoryChanges = { ...edit };
  for (const [field, change] of Object.entries(autofill)) {
    if (!isDeepStrictEqual(current[field], change.to)) continue;
    merged[field] = { from: edit[field]?.from ?? change.from, to: change.to };
  }
  return merged;
}
