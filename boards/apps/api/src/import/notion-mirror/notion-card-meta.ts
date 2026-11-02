import type { ImportedTask } from "@kaneo/importers";
import { BACKLOG_ID_FIELD } from "./notion-footer";

// The Notion fields a card keeps next to kaneo's own (R-024), read from the
// page's source fields by name.
export type NotionCardMeta = {
  kind: "task" | "bug";
  severity: string | null;
  backlogId: string | null;
  halfBaked: boolean;
  report: string | null;
  notionPageId: string;
  notionStatus: string | null;
  notionEditedAt: Date | null;
};

const HALF_BAKED = /^half[-\s]?baked/i;
const REPORT = /^report$/i;
const SEVERITY = /^severity$/i;
const TYPE = /^type$/i;
const STATUS = /^status$/i;
const BUG_TYPE = /bug|ошибк|баг/i;

// keepsBacklogId is false for a page whose Backlog ID another card holds
// (resolveBacklogIds): the ID then stays in the body's footer only.
export function notionCardMeta(
  task: ImportedTask,
  keepsBacklogId = true,
): NotionCardMeta | null {
  const ref = task.sourceRef;
  if (ref?.system !== "notion") return null;

  const fields = Object.entries(task.extraFields ?? {});
  const field = (pattern: RegExp) =>
    fields.find(([name]) => pattern.test(name))?.[1];
  const text = (pattern: RegExp) => {
    const value = field(pattern);
    if (typeof value === "number") return String(value);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const editedAt = Date.parse(ref.lastEditedTime);

  return {
    // A page without Type takes its database's kind: Ошибки holds bugs.
    kind: BUG_TYPE.test(text(TYPE) ?? ref.database ?? "") ? "bug" : "task",
    severity: text(SEVERITY),
    backlogId: keepsBacklogId ? backlogIdOf(task) : null,
    halfBaked: field(HALF_BAKED) === true,
    report: text(REPORT),
    notionPageId: ref.pageId,
    notionStatus: text(STATUS),
    notionEditedAt: Number.isNaN(editedAt) ? null : new Date(editedAt),
  };
}

// Raw, untrimmed, as the footer and the reconciliation hold it: the value is
// a unique key, and two IDs that differ by a space are two IDs.
export function backlogIdOf(task: ImportedTask): string | null {
  const entry = Object.entries(task.footer ?? {}).find(([name]) =>
    BACKLOG_ID_FIELD.test(name),
  );
  return entry ? String(entry[1]) : null;
}
