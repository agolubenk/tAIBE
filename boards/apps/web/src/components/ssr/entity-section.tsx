import { useTranslation } from "react-i18next";
import type { SsrEntity } from "@/fetchers/ssr/ssr-fetchers";
import { isSsrKind } from "./ssr-kind";
import { VersionRow } from "./version-row";

export const entityAnchor = (entityId: string) => `ssr-entity-${entityId}`;

// One registry entity: name, kind, path, status and its ten newest versions.
// The section takes focus when the matching bar locates it.
export function EntitySection({
  workspaceId,
  entity,
  latestNumber,
}: {
  workspaceId: string;
  entity: SsrEntity;
  latestNumber: number | null;
}) {
  const { t } = useTranslation();
  return (
    <section
      id={entityAnchor(entity.id)}
      tabIndex={-1}
      className="rounded-md border border-border bg-card overflow-hidden"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium">{entity.name}</span>
          <span className="text-muted-foreground text-xs">
            {isSsrKind(entity.kind)
              ? t(`workspace:ssr.kind.${entity.kind}`)
              : entity.kind}
          </span>
          <span className="text-muted-foreground font-mono text-xs">
            {entity.path}
          </span>
        </div>
        <span className="text-muted-foreground text-xs">{entity.status}</span>
      </header>
      <ol>
        {entity.versions.slice(0, 10).map((version) => (
          <VersionRow
            key={version.id}
            workspaceId={workspaceId}
            entity={entity}
            version={version}
            latestNumber={latestNumber}
          />
        ))}
      </ol>
    </section>
  );
}
