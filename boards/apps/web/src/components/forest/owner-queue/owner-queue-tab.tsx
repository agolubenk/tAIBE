import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  OwnerQueueCollection,
  OwnerQueueState,
} from "@/fetchers/forest/list-owner-queue";
import useOwnerQueue from "@/hooks/queries/forest/use-owner-queue";
import { ForestListState } from "../forest-list-state";
import { ownerQueueErrorText } from "./owner-queue-error";
import { OwnerQueueRowItem } from "./owner-queue-row";

const COLLECTIONS = ["items", "checks"] as const;
const STATES = ["open", "answered", "all"] as const;
const ALL = "__all__";

const isCollection = (value: unknown): value is OwnerQueueCollection =>
  (COLLECTIONS as readonly unknown[]).includes(value);
const isState = (value: unknown): value is OwnerQueueState =>
  (STATES as readonly unknown[]).includes(value);

// TB-156 (spec owner-queue-move §5.6): the owner's queue, read only, 50 a
// page. The owner answers in the console (or a card's «да» request), never
// here.
export function OwnerQueueTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [collection, setCollection] = useState<OwnerQueueCollection>("items");
  const [state, setState] = useState<OwnerQueueState>("open");
  const [product, setProduct] = useState(ALL);
  const [page, setPage] = useState(1);
  const queue = useOwnerQueue(workspaceId, {
    collection,
    state,
    product: product === ALL ? undefined : product,
    page,
  });
  const data = queue.data;
  const docs = data?.docs ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const first = data && data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.total, data.page * data.pageSize) : 0;

  const refilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-muted-foreground text-sm">
          {t("workspace:forest.hints.queue")}
        </p>
        {data?.queueUrl ? (
          <Button
            size="sm"
            variant="outline"
            render={
              <a
                href={data.queueUrl}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
            {t("workspace:forest.queue.openConsole")}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ToggleGroup
          variant="outline"
          size="sm"
          aria-label={t("workspace:forest.queue.collectionLabel")}
          value={[collection]}
          onValueChange={(value) => {
            const next = value[0];
            if (isCollection(next)) refilter(() => setCollection(next));
          }}
        >
          {COLLECTIONS.map((item) => (
            <ToggleGroupItem key={item} value={item}>
              {t(`workspace:forest.queue.collection.${item}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {collection === "items" ? (
          <ToggleGroup
            variant="outline"
            size="sm"
            aria-label={t("workspace:forest.queue.stateLabel")}
            value={[state]}
            onValueChange={(value) => {
              const next = value[0];
              if (isState(next)) refilter(() => setState(next));
            }}
          >
            {STATES.map((item) => (
              <ToggleGroupItem key={item} value={item}>
                {t(`workspace:forest.queue.state.${item}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
        <Select
          value={product}
          onValueChange={(value) => {
            if (typeof value === "string") refilter(() => setProduct(value));
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-48"
            aria-label={t("workspace:forest.queue.productLabel")}
          >
            <SelectValue>
              {product === ALL
                ? t("workspace:forest.queue.allProducts")
                : product}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {t("workspace:forest.queue.allProducts")}
            </SelectItem>
            {(data?.products ?? []).map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {data?.truncated ? (
        <p role="status" className="text-muted-foreground text-xs">
          {data.collectionTotal !== null
            ? t("workspace:forest.queue.truncated", {
                total: data.collectionTotal,
              })
            : t("workspace:forest.queue.truncatedNoTotal")}
        </p>
      ) : null}
      <ForestListState
        isLoading={queue.isLoading}
        isError={queue.isError}
        isEmpty={!docs.length}
        empty={t("workspace:forest.queue.empty")}
        error={ownerQueueErrorText(queue.error, t)}
      >
        <ul
          className="flex flex-col gap-2 transition-opacity aria-busy:opacity-60"
          aria-busy={queue.isPlaceholderData}
        >
          {docs.map((row) => (
            <OwnerQueueRowItem
              key={`${collection}:${row.id}`}
              workspaceId={workspaceId}
              collection={collection}
              row={row}
            />
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("workspace:forest.queue.range", {
              first,
              last,
              total: data?.total ?? 0,
            })}
            {data?.order
              ? ` · ${t(`workspace:forest.queue.order.${data.order}`)}`
              : null}
          </span>
          {pages > 1 ? (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={page <= 1 || queue.isFetching}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                {t("workspace:forest.queue.previous")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={page >= pages || queue.isFetching}
                onClick={() => setPage((value) => Math.min(pages, value + 1))}
              >
                {t("workspace:forest.queue.next")}
              </Button>
            </div>
          ) : null}
        </div>
      </ForestListState>
    </div>
  );
}
