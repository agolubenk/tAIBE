import { BotIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings/settings-row";
import { StatusBadge } from "@/components/settings/status-badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type listAgents from "@/fetchers/agent-identity/list-agents";
import useSetAgentEnabled from "@/hooks/mutations/agent-identity/use-set-agent-enabled";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { agentState } from "./group-agents";

export type AgentItem = Awaited<ReturnType<typeof listAgents>>[number];

// One session's agent: what it is called, when it last took a key, and the
// switch that stops all its keys at once. A disabled agent gets no switch
// back on: the owner moves it to the archive, and its session brings it back
// from there (TB-74).
export function AgentRow({ agent }: { agent: AgentItem }) {
  const { t } = useTranslation();
  const { mutate, isPending } = useSetAgentEnabled();
  const state = agentState(agent);
  const active = state === "active";
  const switchId = `agent-enabled-${agent.id}`;

  const badge =
    state === "disabled" ? (
      <StatusBadge tone="destructive">
        {t("settings:agentsPage.row.disabled")}
      </StatusBadge>
    ) : active ? (
      <StatusBadge tone={agent.keys.length ? "success" : "neutral"}>
        {t("settings:agentsPage.row.keys", { count: agent.keys.length })}
      </StatusBadge>
    ) : undefined;

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
      {state === "disabled" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t("settings:agentsPage.row.toArchiveLabel", {
            name: agent.name,
          })}
          disabled={isPending}
          onClick={() => mutate({ agentId: agent.id, enabled: true })}
        >
          {t("settings:agentsPage.row.toArchive")}
        </Button>
      ) : (
        <>
          <label htmlFor={switchId} className="sr-only">
            {active
              ? t("settings:agentsPage.row.toggle", { name: agent.name })
              : t("settings:agentsPage.row.mayReturn", { name: agent.name })}
          </label>
          <Switch
            id={switchId}
            checked
            disabled={isPending}
            onCheckedChange={(next) =>
              mutate({ agentId: agent.id, enabled: next })
            }
          />
        </>
      )}
    </SettingsRow>
  );
}
