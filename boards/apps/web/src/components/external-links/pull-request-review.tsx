import { Loader2, ScanSearch } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import useRequestPullRequestReview from "@/hooks/mutations/external-link/use-request-pull-request-review";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import {
  getPullRequestReviewState,
  getReviewHref,
} from "@/lib/pull-request-review";
import type { ExternalLink } from "@/types/external-link";

interface PullRequestReviewProps {
  taskId: string;
  link: ExternalLink;
}

// TB-172: a sibling of the row's link, never inside it. The state comes from
// the server (metadata), so a running review keeps the button off after a
// reload; while the request is in flight the button is off too.
export function PullRequestReview({ taskId, link }: PullRequestReviewProps) {
  const { t } = useTranslation();
  const request = useRequestPullRequestReview();
  const state = getPullRequestReviewState(link);
  const doneAt = link.metadata?.reviewDoneAt;
  const doneHref = state === "done" ? getReviewHref(link) : null;
  const disabled = request.isPending || state === "running" || state === "fork";
  // Two quick presses land before the disabled button renders: one request.
  const inFlight = useRef(false);
  const press = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    request.mutate(
      { taskId, id: link.id },
      {
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      {state === "running" && (
        <span
          role="status"
          className="flex items-center gap-1 text-muted-foreground text-xs"
        >
          <Loader2
            aria-hidden="true"
            className="size-3 animate-spin motion-reduce:animate-none"
          />
          {t("settings:externalLinks.review.running")}
        </span>
      )}
      {state === "fork" && (
        <span
          className="max-w-[8rem] truncate text-muted-foreground text-xs sm:max-w-none"
          title={t("settings:externalLinks.review.forkOnly")}
        >
          {t("settings:externalLinks.review.forkOnly")}
        </span>
      )}
      {doneAt && doneHref && (
        <a
          href={doneHref}
          target="_blank"
          rel="noopener noreferrer"
          title={formatDateTime(doneAt)}
          className="truncate text-success-foreground text-xs outline-none hover:underline focus-visible:underline"
        >
          {t("settings:externalLinks.review.done", {
            time: formatRelativeTime(doneAt),
          })}
        </a>
      )}
      <button
        type="button"
        aria-label={t("settings:externalLinks.review.request", {
          title: link.title || `#${link.externalId}`,
        })}
        title={t("settings:externalLinks.review.requestHint")}
        disabled={disabled}
        onClick={press}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      >
        {request.isPending ? (
          <Loader2
            aria-hidden="true"
            className="size-3.5 animate-spin motion-reduce:animate-none"
          />
        ) : (
          <ScanSearch aria-hidden="true" className="size-3.5" />
        )}
      </button>
    </div>
  );
}
