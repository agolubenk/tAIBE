import { useTranslation } from "react-i18next";
import { formatDateTime } from "@/lib/format";
import { isRefreshable } from "./added-source-kind";
import type { NotebookSource } from "./notebook-types";
import { RefreshSourceButton } from "./refresh-source-button";
import { SourceLabel } from "./source-label";

type SourceRowProps = {
  workspaceId: string;
  source: NotebookSource;
  canRefresh: boolean;
};

export function SourceRow({ workspaceId, source, canRefresh }: SourceRowProps) {
  const { t } = useTranslation();
  const complete = source.embedded >= source.chunks;

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
      <SourceLabel kind={source.kind} ref_={source.ref} title={source.title} />
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex flex-col items-end text-xs">
          <span
            className={
              complete ? "text-muted-foreground" : "text-warning-foreground"
            }
          >
            {t("workspace:notebook.sources.chunks", {
              embedded: source.embedded,
              chunks: source.chunks,
            })}
          </span>
          <span className="text-muted-foreground">
            {formatDateTime(source.updatedAt)}
          </span>
        </div>
        {canRefresh && isRefreshable(source.kind) ? (
          <RefreshSourceButton
            workspaceId={workspaceId}
            kind={source.kind}
            ref_={source.ref}
            title={source.title}
          />
        ) : null}
      </div>
    </li>
  );
}
