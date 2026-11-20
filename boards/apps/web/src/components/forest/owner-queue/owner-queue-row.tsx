import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { OwnerQueueCollection } from "@/fetchers/forest/list-owner-queue";
import { cn } from "@/lib/cn";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { OwnerQueueRow } from "../forest-types";
import { OwnerQueueDoc } from "./owner-queue-doc";

type OwnerQueueRowItemProps = {
  workspaceId: string;
  collection: OwnerQueueCollection;
  row: OwnerQueueRow;
};

// A row carries no body: the body, the answer, the journals and the files
// load when it opens.
export function OwnerQueueRowItem({
  workspaceId,
  collection,
  row,
}: OwnerQueueRowItemProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <li className="rounded-lg border bg-card">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 basis-48 truncate font-medium text-sm">
          {row.title}
        </span>
        {row.product ? <Badge variant="outline">{row.product}</Badge> : null}
        {row.kind ? (
          <Badge variant="secondary">
            {row.inboxType ? `${row.kind} · ${row.inboxType}` : row.kind}
          </Badge>
        ) : null}
        {row.pr !== null ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            #{row.pr}
          </span>
        ) : null}
        {row.state ? (
          <Badge variant={row.state === "open" ? "default" : "outline"}>
            {t(`workspace:forest.queue.rowState.${row.state}`)}
          </Badge>
        ) : null}
        {row.choice ? (
          <span className="text-muted-foreground text-xs">
            {t("workspace:forest.queue.choice", { choice: row.choice })}
          </span>
        ) : null}
        <span
          className="text-muted-foreground text-xs"
          title={formatDateTime(row.updatedAt)}
        >
          {formatRelativeTime(row.updatedAt)}
        </span>
      </button>
      {open ? (
        <div className="border-t px-4 py-2.5">
          <OwnerQueueDoc
            workspaceId={workspaceId}
            collection={collection}
            id={row.id}
          />
        </div>
      ) : null}
    </li>
  );
}
