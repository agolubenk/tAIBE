import { BotIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings/settings-row";
import { StatusBadge } from "@/components/settings/status-badge";
import { Switch } from "@/components/ui/switch";
import type listAgents from "@/fetchers/agent-identity/list-agents";
import useSetAgentEnabled from "@/hooks/mutations/agent-identity/use-set-agent-enabled";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { agentState } from "./group-agents";

export type AgentItem = Awaited<ReturnType<typeof listAgents>>[number];

// One session's agent: what it is called, when it last took a key, and the
// switch that stops all its keys at once. On a disabled agent the switch
// moves it to the archive, from where its session brings it back (TB-74).
export function AgentRow({ agent }: { agent: AgentItem }) {
  const { t } = useTranslation();
  const { mutate, isPending } = useSetAgentEnabled();
  const state = agentState(agent);
  const active = state === "active";
  const switchId = `agent-enabled-${agent.id}`;
  const switchLabel =
    state === "disabled"
      ? t("settings:agentsPage.row.toArchive", { name: agent.name })
      : t("settings:agentsPage.row.toggle", { name: agent.name });

  const badge = {
    active: (
      <StatusBadge tone={agent.keys.length ? "success" : "neutral"}>
        {t("settings:agentsPage.row.keys", { count: agent.keys.length })}
      </StatusBadge>
    ),
    archived: (
      <StatusBadge tone="neutral">
        {t("settings:agentsPage.row.archived")}
      </StatusBadge>
    ),
    disabled: (
      <StatusBadge tone="destructive">
        {t("settings:agentsPage.row.disabled")}
      </StatusBadge>
    ),
  }[state];

  return (
    <SettingsRow
      icon={<BotIcon className={active ? undefined : "opacity-50"} />}
      title={agent.name}
      titleClassName={active ? undefined : "text-muted-foreground"}
      badge={badge}
      description={
        <span className="truncate">
          {agent.harness}
          {" · "}
          {agent.lastIssuedAt ? (
            <span title={formatDateTime(agent.lastIssuedAt)}>
              {t("settings:agentsPage.row.lastKey", {
                time: formatRelativeTime(agent.lastIssuedAt),
              })}
            </span>
          ) : (
            t("settings:agentsPage.row.noKey")
          )}
        </span>
      }
    >
      <label htmlFor={switchId} className="sr-only">
        {switchLabel}
      </label>
      <Switch
        id={switchId}
        title={switchLabel}
        checked={state !== "disabled"}
        disabled={isPending}
        onCheckedChange={(next) => mutate({ agentId: agent.id, enabled: next })}
      />
    </SettingsRow>
  );
}
