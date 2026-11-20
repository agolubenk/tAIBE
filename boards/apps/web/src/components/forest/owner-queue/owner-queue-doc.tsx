import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import type { OwnerQueueCollection } from "@/fetchers/forest/list-owner-queue";
import useOwnerQueueDoc from "@/hooks/queries/forest/use-owner-queue-doc";
import { formatDateTime } from "@/lib/format";
import type { OwnerQueueDocView } from "../forest-types";
import { ownerQueueErrorText } from "./owner-queue-error";

// A long journal shows its newest events; the rest is in the console.
const EVENTS_SHOWN = 20;

type QueueEvent = OwnerQueueDocView["history"][number];
type QueueFile = OwnerQueueDocView["files"][number];

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : null;

function bodyOf(data: Record<string, unknown>) {
  const inbox =
    data.inbox && typeof data.inbox === "object"
      ? (data.inbox as Record<string, unknown>)
      : null;
  return text(data.body) ?? text(inbox?.text);
}

function formatSize(size: number, locale: string) {
  const kb = size / 1024;
  const [value, unit] = kb < 1024 ? [kb, "kilobyte"] : [kb / 1024, "megabyte"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    maximumFractionDigits: 1,
  }).format(value);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="font-medium text-muted-foreground text-xs">{title}</h4>
      {children}
    </section>
  );
}

function EventList({ events }: { events: QueueEvent[] }) {
  const { t } = useTranslation();
  if (!events.length) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("workspace:forest.queue.history.empty")}
      </p>
    );
  }
  const newest = [...events].sort((a, b) => b.at - a.at);
  const shown = newest.slice(0, EVENTS_SHOWN);
  return (
    <>
      <ol className="flex flex-col gap-0.5 text-xs">
        {shown.map((event) => (
          <li
            key={`${event.at}:${event.actor}:${event.action}`}
            className="flex flex-wrap gap-x-2"
          >
            <span className="text-muted-foreground tabular-nums">
              {formatDateTime(event.at)}
            </span>
            <span className="font-medium">{event.action}</span>
            <span className="min-w-0 break-all text-muted-foreground">
              {event.actor}
            </span>
          </li>
        ))}
      </ol>
      {newest.length > shown.length ? (
        <p className="text-muted-foreground text-xs">
          {t("workspace:forest.queue.history.older", {
            n: newest.length - shown.length,
          })}
        </p>
      ) : null}
    </>
  );
}

function FileList({
  files,
  queueUrl,
}: {
  files: QueueFile[];
  queueUrl: string;
}) {
  const { t, i18n } = useTranslation();
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {files.map((file) => (
        <li key={file.id} className="flex flex-wrap gap-x-2">
          <span className="min-w-0 break-all font-medium">{file.name}</span>
          <span className="text-muted-foreground">
            {file.kind} · {formatSize(file.size, i18n.language)} ·{" "}
            {formatDateTime(file.createdAt)}
          </span>
        </li>
      ))}
      <li>
        <a
          href={queueUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs underline underline-offset-2"
        >
          {t("workspace:forest.queue.files.open")}
        </a>
      </li>
    </ul>
  );
}

function Answer({ data }: { data: Record<string, unknown> | undefined }) {
  const { t } = useTranslation();
  const choice = text(data?.choice);
  const note = text(data?.note);
  const at = text(data?.at);
  const done = typeof data?.done === "boolean" ? data.done : null;
  if (!choice && !note && done === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("workspace:forest.queue.answer.none")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <p className="flex flex-wrap gap-x-3">
        {choice ? (
          <span>{t("workspace:forest.queue.choice", { choice })}</span>
        ) : null}
        {done !== null ? (
          <span>
            {t(`workspace:forest.queue.answer.${done ? "done" : "notDone"}`)}
          </span>
        ) : null}
        {at ? (
          <span className="text-muted-foreground text-xs">
            {formatDateTime(at)}
          </span>
        ) : null}
      </p>
      {note ? <p className="whitespace-pre-wrap break-words">{note}</p> : null}
    </div>
  );
}

type OwnerQueueDocProps = {
  workspaceId: string;
  collection: OwnerQueueCollection;
  id: string;
};

// The item as the console keeps it: its text, the owner's answer, the item's
// and the answer's journals, and attachment metadata. Plain text only: an
// item body is never rendered as HTML.
export function OwnerQueueDoc({
  workspaceId,
  collection,
  id,
}: OwnerQueueDocProps) {
  const { t } = useTranslation();
  const view = useOwnerQueueDoc(workspaceId, collection, id);

  if (view.isLoading) {
    return (
      <div className="flex flex-col gap-2 py-1">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (view.isError || !view.data) {
    return (
      <p role="alert" className="py-1 text-muted-foreground text-sm">
        {ownerQueueErrorText(view.error, t) ?? t("workspace:forest.loadError")}
      </p>
    );
  }

  const { doc, check, history, checkHistory, files, queueUrl } = view.data;
  const body = bodyOf(doc.data);
  const items = collection === "items";

  return (
    <div className="flex flex-col gap-3 py-1">
      {body ? (
        <p className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-sm">
          {body}
        </p>
      ) : null}
      <Section title={t("workspace:forest.queue.answer.title")}>
        <Answer data={items ? check?.data : doc.data} />
      </Section>
      {files.length ? (
        <Section title={t("workspace:forest.queue.files.title")}>
          <FileList files={files} queueUrl={queueUrl} />
        </Section>
      ) : null}
      <Section title={t("workspace:forest.queue.history.item")}>
        <EventList events={history} />
      </Section>
      {items ? (
        <Section title={t("workspace:forest.queue.history.answer")}>
          <EventList events={checkHistory} />
        </Section>
      ) : null}
      <p className="text-muted-foreground text-xs tabular-nums">
        {doc.id} · v{doc.version}
      </p>
    </div>
  );
}
