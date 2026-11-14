import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import useApprovals from "@/hooks/queries/forest/use-approvals";
import { authClient } from "@/lib/auth-client";
import { hasInstanceAdminRole } from "@/lib/instance-admin";
import { ApprovalsTab } from "./approvals-tab";
import { type ForestTab, isForestTab, visibleForestTabs } from "./forest-types";
import { JournalTab } from "./journal-tab";
import { LeasesTab } from "./leases-tab";
import { LogsTab } from "./logs-tab";
import { MirrorTab } from "./mirror-tab";
import { PulseTab } from "./pulse-tab";
import { SectorsTab } from "./sectors-tab";
import { SessionsTab } from "./sessions-tab";
import { TreesTab } from "./trees-tab";

// The graph's code loads only when its tab opens (AC-018): Tabs mounts the
// open panel alone, so the import() runs on the first visit.
const GraphTab = lazy(() =>
  import("./graph/graph-tab").then((module) => ({ default: module.GraphTab })),
);
// TB-156: the owner queue is the owner's alone; members never load its code.
const OwnerQueueTab = lazy(() =>
  import("./owner-queue/owner-queue-tab").then((module) => ({
    default: module.OwnerQueueTab,
  })),
);

const panelFallback = (
  <div className="flex flex-col gap-2">
    {[1, 2, 3].map((row) => (
      <Skeleton key={row} className="h-11 w-full rounded-lg" />
    ))}
  </div>
);

type ForestPageProps = {
  workspaceId: string;
  tab: ForestTab;
  sectorId?: string;
  onTabChange: (tab: ForestTab) => void;
};

// What is on fire and waits for the owner (R-090), trees, sectors, felled logs
// with their seeds, «да» requests and leases of a workspace in one place
// (R-028, R-029, N-011), what each session is doing (R-037), the agents' feed
// and the links graph (R-090), and the Notion mirror's reconciliation runs
// (AC-002, AC-003), and the owner's queue from the ops-console (TB-156).
export function ForestPage({
  workspaceId,
  tab: requested,
  sectorId,
  onTabChange,
}: ForestPageProps) {
  const { t } = useTranslation();
  const { data: pending } = useApprovals(workspaceId, "pending");
  const pendingCount = pending?.items.length ?? 0;
  const { data: session } = authClient.useSession();
  const isOwner = hasInstanceAdminRole(session?.user?.role);
  const tabs = visibleForestTabs(isOwner);
  // A shared link to the queue tab opens the pulse for everyone else.
  const tab = tabs.includes(requested) ? requested : "pulse";

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (isForestTab(value)) onTabChange(value);
      }}
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4 sm:px-6"
    >
      <div className="overflow-x-auto">
        <TabsList variant="underline">
          {tabs.map((item) => (
            <TabsTab key={item} value={item} className="gap-1.5">
              {t(`workspace:forest.tabs.${item}`)}
              {item === "approvals" && pendingCount > 0 ? (
                <span className="flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-foreground px-1 font-semibold text-[11px] text-background tabular-nums">
                  {pendingCount}
                </span>
              ) : null}
            </TabsTab>
          ))}
        </TabsList>
      </div>
      <TabsPanel value="pulse">
        <PulseTab workspaceId={workspaceId} onTabChange={onTabChange} />
      </TabsPanel>
      <TabsPanel value="trees">
        <TreesTab workspaceId={workspaceId} />
      </TabsPanel>
      <TabsPanel value="sectors">
        <SectorsTab workspaceId={workspaceId} sectorId={sectorId} />
      </TabsPanel>
      <TabsPanel value="graph">
        <Suspense
          fallback={<Skeleton className="aspect-[16/11] w-full rounded-lg" />}
        >
          <GraphTab workspaceId={workspaceId} />
        </Suspense>
      </TabsPanel>
      <TabsPanel value="logs">
        <LogsTab workspaceId={workspaceId} />
      </TabsPanel>
      <TabsPanel value="approvals">
        <ApprovalsTab workspaceId={workspaceId} />
      </TabsPanel>
      <TabsPanel value="leases">
        <LeasesTab workspaceId={workspaceId} />
      </TabsPanel>
      <TabsPanel value="sessions">
        <SessionsTab workspaceId={workspaceId} />
      </TabsPanel>
      <TabsPanel value="journal">
        <JournalTab workspaceId={workspaceId} />
      </TabsPanel>
      <TabsPanel value="mirror">
        <MirrorTab workspaceId={workspaceId} />
      </TabsPanel>
      {isOwner ? (
        <TabsPanel value="queue">
          <Suspense fallback={panelFallback}>
            <OwnerQueueTab workspaceId={workspaceId} />
          </Suspense>
        </TabsPanel>
      ) : null}
    </Tabs>
  );
}
