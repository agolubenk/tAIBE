import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import useCardMemory from "@/hooks/queries/forest/use-card-memory";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

// claude-mem observations that name the card exactly (TB-113): per key — the
// card id, board key, Backlog ID and queue items of its «да» requests — how
// many and the 5 newest titles. Read-only; a sleeping Mac shows the last
// answer for up to a day.
export function CardMemory({
  workspaceId,
  taskId,
}: {
  workspaceId: string;
  taskId: string;
}) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useCardMemory(workspaceId, taskId);

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
        {t("tasks:card.memory.unavailable")}
      </p>
    );
  }

  const named = data.keys.filter((group) => group.count > 0);
  return (
    <>
      {data.stale && data.fetchedAt ? (
        <p className="px-2 py-1 text-muted-foreground text-xs">
          {t("tasks:card.memory.stale", {
            time: formatDateTime(data.fetchedAt),
          })}
        </p>
      ) : null}
      {named.length ? (
        <ul className="flex flex-col gap-2">
          {named.map((group) => (
            <li key={group.key} className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-baseline gap-1 px-2 text-muted-foreground text-xs">
                <span className="truncate font-mono text-foreground">
                  {group.key}
                </span>
                <span className="shrink-0">
                  {" · "}
                  {t(`tasks:card.memory.matched.${group.matchedOn}`)}
                  {" · "}
                  {t("tasks:card.memory.count", {
                    total: group.capped ? `${group.count}+` : group.count,
                  })}
                </span>
              </span>
              <ul className="flex flex-col gap-0.5">
                {group.latest.map((line) => (
                  <li
                    key={line.id}
                    className="flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1 hover:bg-accent/40"
                  >
                    <span className="truncate font-medium text-[13px] text-foreground">
                      {line.title ?? `#${line.id}`}
                    </span>
                    <span className="truncate text-muted-foreground text-xs">
                      <span title={formatDateTime(line.createdAt)}>
                        {formatRelativeTime(line.createdAt)}
                      </span>
                      {" · "}
                      {line.project}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 py-1 text-muted-foreground text-xs">
          {t("tasks:card.memory.empty")}
        </p>
      )}
    </>
  );
}
