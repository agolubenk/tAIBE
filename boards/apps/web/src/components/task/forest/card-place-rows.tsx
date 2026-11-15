import { Link } from "@tanstack/react-router";
import { ChevronRight, Layers } from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { ForestTaskLink } from "@/components/forest/forest-task-link";
import { Skeleton } from "@/components/ui/skeleton";
import useCardPlace from "@/hooks/queries/forest/use-card-place";
import { PropertyRow } from "../properties/property-row";
import { CardValue } from "./card-value";

type CardPlaceRowsProps = {
  workspaceId: string;
  taskId: string;
};

// Where the card sits in the forest: its parents up to the tree's root, how
// far its subcards and the whole tree are done, and the tree's sector.
export function CardPlaceRows({ workspaceId, taskId }: CardPlaceRowsProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useCardPlace(workspaceId, taskId);

  if (isLoading) {
    return <Skeleton className="mx-2 my-1 h-4 w-2/3" />;
  }
  if (isError || !data) {
    return (
      <p className="px-2 py-1 text-muted-foreground text-xs">
        {t("tasks:card.place.loadError")}
      </p>
    );
  }

  const isRoot = data.ancestors.length === 0 && data.hiddenAncestors === 0;
  const progress = ({ total, done }: { total: number; done: number }) =>
    total
      ? t("tasks:card.place.progress", { done, total })
      : t("tasks:card.place.none");

  return (
    <>
      <PropertyRow label={t("tasks:card.place.path")}>
        <CardValue className="flex-wrap gap-1 py-1">
          {isRoot ? (
            <span className="font-normal text-muted-foreground">
              {t("tasks:card.place.isRoot")}
            </span>
          ) : (
            <>
              {data.hiddenAncestors ? (
                <span className="font-normal text-muted-foreground">
                  {t("tasks:card.place.hidden", {
                    count: data.hiddenAncestors,
                  })}
                </span>
              ) : null}
              {data.ancestors.map((parent, index) => (
                <Fragment key={parent.id}>
                  {index || data.hiddenAncestors ? (
                    <ChevronRight
                      aria-hidden="true"
                      className="text-muted-foreground"
                    />
                  ) : null}
                  <ForestTaskLink
                    workspaceId={workspaceId}
                    projectId={parent.projectId}
                    taskId={parent.id}
                    number={parent.number}
                    title={parent.title}
                  />
                </Fragment>
              ))}
            </>
          )}
        </CardValue>
      </PropertyRow>
      <PropertyRow label={t("tasks:card.place.subcards")}>
        <CardValue>{progress(data.subcards)}</CardValue>
      </PropertyRow>
      {isRoot ? null : (
        <PropertyRow label={t("tasks:card.place.tree")}>
          <CardValue>{progress(data.tree)}</CardValue>
        </PropertyRow>
      )}
      <PropertyRow label={t("tasks:card.place.sector")}>
        <CardValue className="flex-wrap gap-1 py-1">
          {data.sectors.length
            ? data.sectors.map((sector) => (
                <Link
                  key={sector.id}
                  to="/dashboard/workspace/$workspaceId/forest"
                  params={{ workspaceId }}
                  search={{ tab: "sectors" }}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-normal text-xs outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Layers aria-hidden="true" />
                  <span className="truncate" title={sector.name}>
                    {sector.name}
                  </span>
                </Link>
              ))
            : null}
        </CardValue>
      </PropertyRow>
    </>
  );
}
