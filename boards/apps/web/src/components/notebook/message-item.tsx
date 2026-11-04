import { AnswerNote } from "./answer-note";
import { AnswerText } from "./answer-text";
import { BriefBody } from "./brief-body";
import { CitationList } from "./citation-list";
import type { NotebookMessage } from "./notebook-types";

export function MessageItem({ message }: { message: NotebookMessage }) {
  if (message.role === "user") {
    return (
      <p className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-secondary px-3 py-2 text-sm">
        {message.content}
      </p>
    );
  }

  const brief = message.status === "brief" || message.status === "brief-failed";

  return (
    <article className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2.5">
      {brief ? (
        <BriefBody status={message.status} content={message.content} />
      ) : message.status === "answered" ? (
        <AnswerText
          messageId={message.id}
          content={message.content}
          citations={message.citations}
        />
      ) : (
        <AnswerNote
          status={message.status}
          hasSources={message.citations.length > 0}
        />
      )}
      {brief ? null : (
        <CitationList messageId={message.id} citations={message.citations} />
      )}
      {message.model ? (
        <p className="text-[11px] text-muted-foreground">{message.model}</p>
      ) : null}
    </article>
  );
}
