import { ActivityIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsSection } from "@/components/settings/settings-section";
import type { NotebookModelSettings } from "@/fetchers/admin/get-notebook-model";

type UsageRow = NotebookModelSettings["usage"][number];

// One daily limit is shared by every workspace; this shows who spent it.
export function ModelUsageSection({
  settings,
}: {
  settings: NotebookModelSettings;
}) {
  const { t } = useTranslation();

  return (
    <SettingsSection
      title={t("settings:adminNotebookModel.usage.title")}
      description={t("settings:adminNotebookModel.usage.total", {
        count: settings.callsToday,
        max: settings.dailyMax,
      })}
    >
      <SettingsCard>
        {settings.usage.length === 0 ? (
          <p className="px-4 py-3.5 text-muted-foreground text-sm">
            {t("settings:adminNotebookModel.usage.empty")}
          </p>
        ) : (
          settings.usage.map((row) => (
            <SettingsRow
              key={row.workspaceId}
              icon={<ActivityIcon />}
              title={row.name}
              description={
                <>
                  <span className="block">
                    {t("settings:adminNotebookModel.usage.calls", {
                      count: row.calls,
                    })}
                  </span>
                  {row.calls > 0 && <UsageTokens row={row} />}
                </>
              }
            />
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

// TB-134 (D-018): token sums cover only the calls whose provider reported
// usage, so the coverage stands next to them; input already holds cached.
function UsageTokens({ row }: { row: UsageRow }) {
  const { t, i18n } = useTranslation();
  if (row.withUsage === 0) {
    return (
      <span className="block">
        {t("settings:adminNotebookModel.usage.noProviderData")}
      </span>
    );
  }
  const compact = new Intl.NumberFormat(i18n.language, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const full = new Intl.NumberFormat(i18n.language);
  const values = (format: Intl.NumberFormat) => ({
    input: format.format(row.input),
    output: format.format(row.output),
    cached: format.format(row.cached),
  });
  const coverage = t("settings:adminNotebookModel.usage.coverage", {
    count: row.calls,
    withUsage: row.withUsage,
  });

  return (
    <span
      className="block"
      title={`${t("settings:adminNotebookModel.usage.tokens", values(full))} · ${coverage}`}
    >
      {t("settings:adminNotebookModel.usage.tokens", values(compact))} ·{" "}
      {coverage}
    </span>
  );
}
