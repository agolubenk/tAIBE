import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  listSsrDraftMatches,
  listSsrEntities,
} from "@/fetchers/ssr/ssr-fetchers";
import { ApproveMatchingBar } from "./approve-matching-bar";
import { EntitySection, entityAnchor } from "./entity-section";

// «Скиллы и правила» (spec RU-2, RU-11): the registry. Every entity with its
// versions; a diff opens before any owner decision (see VersionRow).
function locateEntity(entityId: string) {
  const section = document.getElementById(entityAnchor(entityId));
  section?.scrollIntoView({ block: "start" });
  section?.focus({ preventScroll: true });
}

export function RegistryTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const entities = useQuery({
    queryKey: ["ssr", "entities", workspaceId],
    queryFn: () => listSsrEntities(workspaceId),
  });
  // Asked only when the registry shows a draft, and as soon as it does.
  const hasDrafts =
    entities.data?.some((entity) =>
      entity.versions.some((version) => version.status === "draft"),
    ) ?? false;
  const drafts = useQuery({
    queryKey: ["ssr", "drafts", workspaceId],
    queryFn: () => listSsrDraftMatches(workspaceId),
    enabled: hasDrafts,
  });

  if (entities.isPending) {
    return (
      <p className="text-muted-foreground px-1 py-8 text-sm">
        {t("common:loading")}
      </p>
    );
  }
  if (entities.isError) {
    return (
      <p className="text-destructive px-1 py-8 text-sm">
        {t("workspace:ssr.loadError")}
      </p>
    );
  }
  const list = entities.data ?? [];
  if (list.length === 0) {
    return (
      <p className="text-muted-foreground px-1 py-8 text-sm">
        {t("workspace:ssr.empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {hasDrafts ? (
        <ApproveMatchingBar
          workspaceId={workspaceId}
          drafts={drafts.data}
          status={drafts.status}
          onLocate={locateEntity}
        />
      ) : null}
      {list.map((entity) => (
        <EntitySection
          key={entity.id}
          workspaceId={workspaceId}
          entity={entity}
          latestNumber={
            entity.versions.find((version) => version.status === "latest")
              ?.number ?? null
          }
        />
      ))}
    </div>
  );
}
