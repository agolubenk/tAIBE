import { toColumnSlug } from "../keys.js";
import type { ImportedTask } from "../types.js";
import type { NotionDatabase, NotionPage } from "./api-types.js";
import { pageIdFromKey } from "./idempotency.js";
import {
  mapColumns,
  pageTitleOf,
  statusNameOf,
  typeNameOf,
} from "./mapping.js";

export type ReconcileDiscrepancyKind =
  | "missing-in-import"
  | "missing-in-source"
  | "status-mismatch"
  | "archive-mismatch";

export type ReconcileDiscrepancy = {
  pageId: string;
  title: string;
  kind: ReconcileDiscrepancyKind;
  detail: string;
};

export type ReconcileSide = { source: number; imported: number };

export type ReconcileReport = {
  totals: ReconcileSide;
  byStatus: Record<string, ReconcileSide>;
  byType: Record<string, ReconcileSide>;
  discrepancies: ReconcileDiscrepancy[];
};

const NO_STATUS = "(no status)";
const NO_TYPE = "(no type)";

// AC-002: counters by type and status plus every discrepancy named by page.
// Pages are matched to tasks through `sourceRef.pageId`, falling back to the
// idempotency key suffix. With the database, a status maps to the same column
// key the importer gave it; without it, to the status slug.
export function reconcile(
  sourcePages: NotionPage[],
  imported: ImportedTask[],
  database?: NotionDatabase,
): ReconcileReport {
  const columnKeyByStatus = database
    ? mapColumns(database).columnKeyByStatus
    : undefined;
  const statusKeyOfPage = (page: NotionPage): string => {
    const name = statusNameOf(page);
    if (!name) return NO_STATUS;
    return columnKeyByStatus?.get(name) ?? (toColumnSlug(name) || name);
  };
  const importedByPageId = new Map<string, ImportedTask>();
  for (const task of imported) {
    const pageId =
      task.sourceRef?.system === "notion"
        ? task.sourceRef.pageId
        : pageIdFromKey(task.key);
    if (pageId) importedByPageId.set(pageId, task);
  }

  const sourceIds = new Set(sourcePages.map((page) => page.id));
  const byStatus: Record<string, ReconcileSide> = {};
  const byType: Record<string, ReconcileSide> = {};
  const discrepancies: ReconcileDiscrepancy[] = [];

  for (const page of sourcePages) {
    const statusKey = statusKeyOfPage(page);
    bump(byStatus, statusKey, "source");
    bump(byType, typeNameOf(page) ?? NO_TYPE, "source");

    const task = importedByPageId.get(page.id);
    if (!task) {
      discrepancies.push({
        pageId: page.id,
        title: pageTitleOf(page),
        kind: "missing-in-import",
        detail: `status ${statusNameOf(page) ?? "none"} in Notion`,
      });
      continue;
    }

    const taskStatusKey = task.columnKey ?? NO_STATUS;
    // A page with no status in Notion cannot match any column: the importer
    // places it in the default one, which is a placement choice, not a
    // divergence. Comparing anyway flagged such a page on every run forever.
    if (statusKey !== NO_STATUS && taskStatusKey !== statusKey) {
      discrepancies.push({
        pageId: page.id,
        title: pageTitleOf(page),
        kind: "status-mismatch",
        detail: `notion=${statusKey}, imported=${taskStatusKey}`,
      });
    }

    const sourceArchived = page.archived || page.in_trash === true;
    if (Boolean(task.archived) !== sourceArchived) {
      discrepancies.push({
        pageId: page.id,
        title: pageTitleOf(page),
        kind: "archive-mismatch",
        detail: `notion archived=${sourceArchived}, imported archived=${Boolean(task.archived)}`,
      });
    }
  }

  for (const [pageId, task] of importedByPageId) {
    bump(byStatus, task.columnKey ?? NO_STATUS, "imported");
    bump(byType, typeOfTask(task), "imported");
    if (!sourceIds.has(pageId)) {
      discrepancies.push({
        pageId,
        title: task.title,
        kind: "missing-in-source",
        detail: "imported task has no matching Notion page",
      });
    }
  }

  return {
    totals: { source: sourcePages.length, imported: importedByPageId.size },
    byStatus,
    byType,
    discrepancies,
  };
}

function typeOfTask(task: ImportedTask): string {
  for (const [name, value] of Object.entries(task.extraFields ?? {})) {
    if (/^type$/i.test(name) && typeof value === "string" && value) {
      return value;
    }
  }
  return NO_TYPE;
}

function bump(
  table: Record<string, ReconcileSide>,
  key: string,
  side: keyof ReconcileSide,
): void {
  const entry = (table[key] ??= { source: 0, imported: 0 });
  entry[side] += 1;
}
