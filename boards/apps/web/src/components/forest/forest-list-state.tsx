import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type ForestListStateProps = {
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  empty: string;
  // A tab that knows why the read failed says so instead of the generic text.
  error?: string;
  // Refetches the failed list in place: without it a dropped request on a slow
  // network leaves the tab dead until the whole page reloads (TB-218).
  onRetry: () => void;
  children: ReactNode;
};

// Loading, error and empty states shared by the forest tabs.
export function ForestListState({
  isLoading,
  isError,
  isEmpty,
  empty,
  error,
  onRetry,
  children,
}: ForestListStateProps) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {[1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-11 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex flex-wrap items-center gap-3 py-6">
        <p role="alert" className="text-muted-foreground text-sm">
          {error ?? t("workspace:forest.loadError")}
        </p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t("common:error.tryAgain")}
        </Button>
      </div>
    );
  }
  if (isEmpty) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
        {empty}
      </p>
    );
  }
  return <>{children}</>;
}
