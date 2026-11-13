import { ChevronRight, MessagesSquare } from "lucide-react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "../ui/collapsible";
import { Timeline, TimelineContent, TimelineItem } from "../ui/timeline";
import type { DialogEntry } from "./group-dialogs";
import Activity from "./index";

type ActivityItem = ComponentProps<typeof Activity>["activity"];

// TB-11 (R-026, AC-010): the talk of linked sessions on the card. An open
// dialog shows inline; an archived one folds to one row and stays readable.
export function SessionDialog({
  dialog,
  step,
}: {
  dialog: DialogEntry<ActivityItem>;
  step: number;
}) {
  const { t } = useTranslation();

  const summary = (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <MessagesSquare
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="font-medium">{t("activity:dialog.title")}</span>
      <Badge size="sm" variant={dialog.open ? "info" : "secondary"}>
        {dialog.open
          ? t("activity:dialog.live")
          : t("activity:dialog.archived")}
      </Badge>
      {dialog.sessions.map((session) => (
        <Badge key={session} size="sm" variant="outline">
          {session}
        </Badge>
      ))}
      <span className="text-muted-foreground text-xs">
        {t("activity:dialog.summary", {
          sessions: dialog.sessions.length,
          messages: dialog.messages.length,
        })}
      </span>
    </span>
  );

  const messages = (
    <Timeline className="mt-1 ml-1.5 border-border/60 border-l pl-2">
      {dialog.messages.map((message, index) => (
        <Activity key={message.id} activity={message} step={index + 1} />
      ))}
    </Timeline>
  );

  return (
    <TimelineItem className="m-0! flex-row items-start py-1!" step={step}>
      <TimelineContent className="min-w-0 flex-1 text-[13px] text-foreground leading-5">
        {dialog.open ? (
          <section
            aria-label={t("activity:dialog.title")}
            className="rounded-md border border-info/24 bg-info/4 px-2 py-1.5"
          >
            {summary}
            {messages}
          </section>
        ) : (
          <Collapsible>
            <CollapsibleTrigger className="flex w-full items-start gap-1 rounded-md px-1 py-0.5 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring data-panel-open:[&>svg]:rotate-90">
              <ChevronRight
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform"
              />
              {summary}
            </CollapsibleTrigger>
            <CollapsiblePanel>{messages}</CollapsiblePanel>
          </Collapsible>
        )}
      </TimelineContent>
    </TimelineItem>
  );
}
