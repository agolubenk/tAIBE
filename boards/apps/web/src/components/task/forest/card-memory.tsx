import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import useCardMemory from "@/hooks/queries/forest/use-card-memory";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

const SHOWN = 5;

// claude-mem observations that name the card (R-042): what agents noted
// while working on it. Read-only; a sleeping worker shows the last copy.
export function CardMemory({
  workspaceId,
  taskId,
}: {
  workspaceId: string;
  taskId: string;
}) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useCardMemory(workspaceId, taskId);
  const [showAll, setShowAll] = useState(false);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 px-2 py-1">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <p className="px-2 py-1 text-destructive-foreground text-xs">
        {t("tasks:card.memory.loadError")}
      </p>
    );
  }
  if (!data.available) {
    return (
      <p className="px-2 py-1 text-muted-foreground text-xs">
        {data.reason === "no-product-map"
          ? t("tasks:card.memory.noProductMap")
          : t("tasks:card.memory.unavailable")}
      </p>
    );
  }

  const items = showAll ? data.items : data.items.slice(0, SHOWN);
  return (
    <>
      {data.stale && data.fetchedAt ? (
        <p className="px-2 py-1 text-muted-foreground text-xs">
          {t("tasks:card.memory.stale", {
            time: formatDateTime(data.fetchedAt),
          })}
        </p>
      ) : null}
      {items.length ? (
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-accent/40"
            >
              <span className="truncate font-medium text-[13px] text-foreground">
                {item.title ?? item.subtitle ?? `#${item.id}`}
              </span>
              <span className="truncate text-muted-foreground text-xs">
                <span title={formatDateTime(item.createdAt)}>
                  {formatRelativeTime(item.createdAt)}
                </span>
                {" · "}
                {item.type}
                {" · "}
                {t(`tasks:card.memory.matched.${item.matchedOn}`, {
                  value: item.matchedValue,
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 py-1 text-muted-foreground text-xs">
          {t("tasks:card.memory.empty", { total: data.scanned })}
        </p>
      )}
      {data.items.length > SHOWN ? (
        <button
          type="button"
          className="self-start px-2 py-1 text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? t("tasks:card.showLess")
            : t("tasks:card.showAll", { total: data.items.length })}
        </button>
      ) : null}
    </>
  );
}
