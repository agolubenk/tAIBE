import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  type ForestTab,
  isForestOwnerRole,
  visibleForestTabs,
} from "@/components/forest/forest-types";
import useSectors from "@/hooks/queries/forest/use-sectors";
import { authClient } from "@/lib/auth-client";
import type { PaletteGroup } from "./palette-filter";

// The forest's tabs and sectors as jump targets (R-090). Sectors load only once
// something is typed: an empty palette lists the commands alone.
export function useForestGroups(
  workspaceId: string | undefined,
  query: string,
): PaletteGroup[] {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const typed = query.trim().length > 0;
  const { data: sectors } = useSectors(typed && workspaceId ? workspaceId : "");
  // The owner queue tab is the owner's alone (TB-156).
  const { data: session } = authClient.useSession();
  const isOwner = isForestOwnerRole(session?.user?.role);

  return useMemo<PaletteGroup[]>(() => {
    if (!workspaceId) return [];
    const goTo = (tab: ForestTab, sector?: string) =>
      navigate({
        to: "/dashboard/workspace/$workspaceId/forest",
        params: { workspaceId },
        search: { tab, sector },
      });

    return [
      {
        value: "forest",
        label: t("navigation:sidebar.forest"),
        kind: "lookup",
        items: visibleForestTabs(isOwner).map((tab) => ({
          value: `forest-${tab}`,
          label: t(`workspace:forest.tabs.${tab}`),
          onRun: () => goTo(tab),
        })),
      },
      {
        value: "sectors",
        label: t("workspace:forest.tabs.sectors"),
        kind: "lookup",
        items: (sectors ?? []).map((sector) => ({
          value: `sector-${sector.id}`,
          label: sector.name,
          onRun: () => goTo("sectors", sector.id),
        })),
      },
    ];
  }, [isOwner, navigate, sectors, t, workspaceId]);
}
