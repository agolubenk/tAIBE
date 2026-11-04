import { useTranslation } from "react-i18next";
import type { NotebookMessage } from "./notebook-types";

type BriefBodyProps = {
  status: NotebookMessage["status"];
  content: string;
};

// A brief is model text for an agent to pick up: shown as written, with no
// source markers, so it reads and copies the same.
export function BriefBody({ status, content }: BriefBodyProps) {
  const { t } = useTranslation();

  return (
    <>
      <h3 className="font-medium text-muted-foreground text-xs">
        {t("workspace:notebook.chat.brief.title")}
      </h3>
      {status === "brief" ? (
        <p className="whitespace-pre-wrap break-words font-mono text-sm">
          {content}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          {t("workspace:notebook.chat.brief.failed")}
        </p>
      )}
    </>
  );
}
