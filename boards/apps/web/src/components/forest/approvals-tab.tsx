import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ApprovalStatusFilter } from "@/fetchers/forest/list-approvals";
import useApprovals from "@/hooks/queries/forest/use-approvals";
import { ApprovalItem } from "./approval-item";
import { ApprovalTarget } from "./approval-target";
import { ForestListState } from "./forest-list-state";

const FILTERS = [
  "pending",
  "consumed",
  "rejected",
  "failed",
  "expired",
  "all",
] as const;
type Filter = (typeof FILTERS)[number];

const isFilter = (value: unknown): value is Filter =>
  (FILTERS as readonly unknown[]).includes(value);

export function ApprovalsTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("pending");
  const status: ApprovalStatusFilter | undefined =
    filter === "all" ? undefined : filter;
  const approvals = useApprovals(workspaceId, status);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-muted-foreground text-sm">
          {t("workspace:forest.hints.approvals")}
        </p>
        <ToggleGroup
          variant="outline"
          size="sm"
          value={[filter]}
          onValueChange={(value) => {
            const next = value[0];
            if (isFilter(next)) setFilter(next);
          }}
        >
          {FILTERS.map((item) => (
            <ToggleGroupItem key={item} value={item}>
              {t(`workspace:forest.approvals.status.${item}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <ForestListState
        isLoading={approvals.isLoading}
        isError={approvals.isError}
        isEmpty={!approvals.data?.items.length}
        empty={t("workspace:forest.approvals.empty")}
      >
        <ul className="grid gap-2 md:grid-cols-2">
          {approvals.data?.items.map((approval) => (
            <li key={approval.id}>
              <ApprovalItem
                workspaceId={workspaceId}
                approval={approval}
                target={
                  <ApprovalTarget
                    workspaceId={workspaceId}
                    approval={approval}
                  />
                }
              />
            </li>
          ))}
        </ul>
      </ForestListState>
    </div>
  );
}
