import { ArchiveIcon, ChevronRightIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsNote } from "@/components/settings/settings-note";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { type AgentItem, AgentRow } from "./agent-row";
import { archiveCount } from "./group-agents";

// TB-74: agents idle for a day, folded away. They hold no place under the
// cap and come back by themselves, so the owner rarely needs to look.
export function ArchivedAgents({
  agents,
  defaultOpen = false,
}: {
  agents: AgentItem[];
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <Collapsible defaultOpen={defaultOpen} className="space-y-2">
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded-md px-0.5 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-panel-open:[&_svg]:rotate-90">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 transition-transform"
        />
        {t("settings:agentsPage.archive.title", {
          total: archiveCount(agents.length),
        })}
      </CollapsibleTrigger>
      <SettingsNote icon={ArchiveIcon}>
        {t("settings:agentsPage.archive.hint")}
      </SettingsNote>
      <CollapsiblePanel>
        <SettingsCard>
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </SettingsCard>
      </CollapsiblePanel>
    </Collapsible>
  );
}
