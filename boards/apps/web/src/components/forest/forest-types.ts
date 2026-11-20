import type listApprovals from "@/fetchers/forest/list-approvals";
import type getGraph from "@/fetchers/forest/get-graph";
import type getOwnerQueueDoc from "@/fetchers/forest/get-owner-queue-doc";
import type listFires from "@/fetchers/forest/list-fires";
import type listJournal from "@/fetchers/forest/list-journal";
import type listLeases from "@/fetchers/forest/list-leases";
import type listLogs from "@/fetchers/forest/list-logs";
import type listMirrorRuns from "@/fetchers/forest/list-mirror-runs";
import type listOwnerQueue from "@/fetchers/forest/list-owner-queue";
import type listSectors from "@/fetchers/forest/list-sectors";
import type listTrees from "@/fetchers/forest/list-trees";
import type listWorkState from "@/fetchers/forest/list-work-state";

export type ForestTree = Awaited<ReturnType<typeof listTrees>>["trees"][number];
export type ForestSector = Awaited<ReturnType<typeof listSectors>>[number];
export type ForestLogSummary = Awaited<
  ReturnType<typeof listLogs>
>["items"][number];
export type ForestApproval = Awaited<
  ReturnType<typeof listApprovals>
>["items"][number];
export type ForestLease = Awaited<ReturnType<typeof listLeases>>[number];
export type ForestSession = Awaited<ReturnType<typeof listWorkState>>[number];
export type ForestJournalEntry = Awaited<
  ReturnType<typeof listJournal>
>["items"][number];
export type ForestFire = Awaited<ReturnType<typeof listFires>>["items"][number];
export type ForestGraphPage = Awaited<ReturnType<typeof getGraph>>;
export type ForestMirror = Awaited<ReturnType<typeof listMirrorRuns>>;
export type ForestMirrorRun = ForestMirror["runs"][number];
export type ForestMirrorDatabase = NonNullable<
  ForestMirror["latest"]
>["report"]["databases"][number];
export type OwnerQueuePage = Awaited<ReturnType<typeof listOwnerQueue>>;
export type OwnerQueueRow = OwnerQueuePage["docs"][number];
export type OwnerQueueDocView = Awaited<ReturnType<typeof getOwnerQueueDoc>>;

export const FOREST_TABS = [
  "pulse",
  "trees",
  "sectors",
  "graph",
  "logs",
  "approvals",
  "leases",
  "sessions",
  "journal",
  "mirror",
  "queue",
] as const;
export type ForestTab = (typeof FOREST_TABS)[number];

// TB-156: the owner queue tab is for the owner's session alone; the API
// answers 403 to everyone else, so the tab does not show to them.
const OWNER_ONLY_TABS: readonly ForestTab[] = ["queue"];

// The API's owner rule, not the instance-admin one: the forest actor is
// «owner-ui» only for the role "admin" itself (apps/api/src/forest/actor.ts:69),
// while hasInstanceAdminRole also takes "user,admin". Such a user would see
// the tab and get 403.
export const isForestOwnerRole = (role: unknown) => role === "admin";

export function visibleForestTabs(isOwner: boolean): readonly ForestTab[] {
  return isOwner
    ? FOREST_TABS
    : FOREST_TABS.filter((tab) => !OWNER_ONLY_TABS.includes(tab));
}

export function isForestTab(value: unknown): value is ForestTab {
  return (FOREST_TABS as readonly unknown[]).includes(value);
}
