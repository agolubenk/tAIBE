import {
  type FetchLike,
  NOTION_DEFAULT_PRODUCT,
  NotionClient,
  type NotionPage,
  notionPlainText,
  readNotionMirror,
  reconcileNotion,
} from "@kaneo/importers";
import { eq } from "drizzle-orm";
import db from "../../database";
import { notionMirrorRunTable } from "../../database/forest-schema";
import { withJobLease } from "../../scheduler/leader-lock";
import { createGuardedFetch } from "../guarded-fetch";
import { writeImportedProject } from "../write-imported-project";
import { loadMirroredCards } from "./load-mirrored-cards";
import { findWorkspaceOwner, loadMirrorRows } from "./load-mirror-rows";
import { NOTION_FOOTER_FIELDS } from "./notion-footer";
import {
  mirrorDatabaseOrder,
  type NotionMirrorConfig,
  readMirrorConfig,
  readMirrorToken,
} from "./mirror-config";
import { closeInterruptedRuns } from "./close-interrupted-runs";
import {
  failedReport,
  MAX_LISTED_DISCREPANCIES,
  type MirrorDatabaseReport,
  runStatusOf,
} from "./mirror-report";
import { snapshotTasks } from "./mirror-snapshot";

export const NOTION_MIRROR_LEASE = "notion-mirror";
// Long enough for a full first read of a few hundred pages with bodies.
const LEASE_MS = 60 * 60 * 1000;

export type MirrorTrigger = "schedule" | "manual";

export type MirrorRunDeps = {
  // Tests replace the network; production goes through the SSRF guard.
  fetch?: FetchLike;
};

export async function runScheduledNotionMirror(): Promise<{
  degraded: boolean;
}> {
  const config = readMirrorConfig();
  if (!config) return { degraded: false };
  return withJobLease(
    NOTION_MIRROR_LEASE,
    async () => {
      const { status } = await mirrorOnce(config, "schedule");
      return { degraded: status === "failed" };
    },
    () => ({ degraded: false }),
    LEASE_MS,
  );
}

// A manual run starts in the background and answers with its id as soon as
// the row exists; null when a scheduled or another manual run holds the lease.
export function startManualMirror(
  config: NotionMirrorConfig,
  deps: MirrorRunDeps = {},
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    withJobLease(
      NOTION_MIRROR_LEASE,
      async () => {
        const runId = await openMirrorRun(config, "manual");
        resolve(runId);
        await completeMirrorRun(config, runId, deps);
      },
      () => resolve(null),
      LEASE_MS,
    ).catch((error: unknown) => {
      console.error("Notion mirror run failed", error);
      reject(error);
    });
  });
}

// One run: sync every configured database, then reconcile Notion against the
// board. A run that cannot finish still leaves a `failed` row, so a gap in
// the mirror is visible rather than silent (AC-003 counts runs without gaps).
export async function mirrorOnce(
  config: NotionMirrorConfig,
  trigger: MirrorTrigger,
  deps: MirrorRunDeps = {},
): Promise<{ runId: string; status: string }> {
  const runId = await openMirrorRun(config, trigger);
  const status = await completeMirrorRun(config, runId, deps);
  return { runId, status };
}

async function openMirrorRun(
  config: NotionMirrorConfig,
  trigger: MirrorTrigger,
): Promise<string> {
  await closeInterruptedRuns(config.workspaceId);
  const [run] = await db
    .insert(notionMirrorRunTable)
    .values({ workspaceId: config.workspaceId, trigger, status: "running" })
    .returning({ id: notionMirrorRunTable.id });
  if (!run) throw new Error("Could not record the mirror run");
  return run.id;
}

async function completeMirrorRun(
  config: NotionMirrorConfig,
  runId: string,
  deps: MirrorRunDeps,
): Promise<string> {
  const databases: MirrorDatabaseReport[] = [];
  let token = "";
  try {
    token = readMirrorToken(config);
    const userId = await findWorkspaceOwner(config.workspaceId);
    if (!userId) throw new Error("The mirror workspace has no owner");
    const client = new NotionClient({
      token,
      fetch: deps.fetch ?? createGuardedFetch("Notion").fetch,
    });
    const databaseIds = config.discover
      ? mirrorDatabaseOrder(
          config.databaseIds,
          (await client.searchDatabases()).map((d) => ({
            id: d.id,
            title: notionPlainText(d.title),
          })),
        )
      : config.databaseIds;
    for (const databaseId of databaseIds) {
      databases.push(
        await mirrorDatabase(client, config, databaseId, userId, token),
      );
    }
  } catch (error) {
    databases.push(failedReport("(setup)", errorText(error, token)));
  }

  const status = runStatusOf(databases);
  await db
    .update(notionMirrorRunTable)
    .set({
      status,
      discrepancyCount: databases.reduce(
        (sum, { discrepancyCount }) => sum + discrepancyCount,
        0,
      ),
      report: { databases },
      finishedAt: new Date(),
    })
    .where(eq(notionMirrorRunTable.id, runId));
  return status;
}

async function mirrorDatabase(
  client: NotionClient,
  config: NotionMirrorConfig,
  databaseId: string,
  userId: string,
  token: string,
): Promise<MirrorDatabaseReport> {
  try {
    const counted = { fresh: 0, changed: 0 };
    const read = await readNotionMirror(client, databaseId, {
      product: config.product ?? NOTION_DEFAULT_PRODUCT,
      footerFields: NOTION_FOOTER_FIELDS,
      selectBodies: async (pages) => {
        const cards = await loadMirroredCards(pages.map(({ id }) => id));
        const editedAt = new Map(
          cards.map((card) => [card.notionPageId, card.notionEditedAt]),
        );
        return new Set(
          pages
            .filter((page) => needsBody(page, editedAt, counted))
            .map(({ id }) => id),
        );
      },
    });

    const written = await writeImportedProject({
      workspaceId: config.workspaceId,
      userId,
      source: "notion",
      project: read.project,
      includeComments: false,
    });
    const rows = await loadMirrorRows(written.projectId);
    const report = reconcileNotion(
      read.pages,
      snapshotTasks(rows, read.project, read.pages),
      read.database,
    );
    return {
      databaseId,
      name: read.project.name,
      read: { pages: read.pages.length, ...counted },
      totals: report.totals,
      byStatus: report.byStatus,
      byType: report.byType,
      discrepancyCount: report.discrepancies.length,
      discrepancies: report.discrepancies.slice(0, MAX_LISTED_DISCREPANCIES),
      error: null,
    };
  } catch (error) {
    return failedReport(databaseId, errorText(error, token));
  }
}

function needsBody(
  page: NotionPage,
  cards: ReadonlyMap<string, Date | null>,
  counted: { fresh: number; changed: number },
): boolean {
  if (!cards.has(page.id)) {
    counted.fresh += 1;
    return true;
  }
  const stored = cards.get(page.id) ?? null;
  const edited = Date.parse(page.last_edited_time);
  if (stored === null || Number.isNaN(edited) || edited > stored.getTime()) {
    counted.changed += 1;
    return true;
  }
  return false;
}

// Errors land in a row the workspace can read: never the token.
function errorText(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const clean = token ? message.split(token).join("***") : message;
  return clean.slice(0, 500);
}
