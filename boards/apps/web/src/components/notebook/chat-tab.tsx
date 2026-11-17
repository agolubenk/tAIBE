import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ForestListState } from "@/components/forest/forest-list-state";
import { Button } from "@/components/ui/button";
import useAskNotebook from "@/hooks/mutations/notebook/use-ask-notebook";
import useNotebookThreads from "@/hooks/queries/notebook/use-notebook-threads";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { AskForm } from "./ask-form";
import { PendingQuestion } from "./pending-question";
import { ThreadList } from "./thread-list";
import { ThreadView } from "./thread-view";

type ChatTabProps = {
  workspaceId: string;
  threadId?: string;
  onThreadChange: (threadId: string | undefined) => void;
};

// Questions to the notebook (R-052): earlier threads on the left, the open
// one on the right with a follow-up box under it.
export function ChatTab({
  workspaceId,
  threadId,
  onThreadChange,
}: ChatTabProps) {
  const { t } = useTranslation();
  const threads = useNotebookThreads(workspaceId);
  const ask = useAskNotebook(workspaceId);
  const { canManageSettings } = useWorkspacePermission();
  const list = threads.data?.threads ?? [];
  // Only the thread the question went to shows it while it is answered.
  const pending =
    ask.isPending && ask.variables.threadId === threadId
      ? ask.variables.question
      : undefined;

  const onAsk = (question: string, done: () => void) =>
    ask.mutate(
      { threadId, question },
      {
        onSuccess: (data) => {
          done();
          if (!threadId) onThreadChange(data.thread.id);
        },
      },
    );

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-muted-foreground text-sm">
        {t("workspace:notebook.hints.chat")}
      </p>
      <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="flex flex-col gap-2">
          <Button
            variant="outline"
            size="sm"
            className="justify-start"
            disabled={!threadId}
            onClick={() => onThreadChange(undefined)}
          >
            <Plus aria-hidden="true" />
            {t("workspace:notebook.chat.newThread")}
          </Button>
          <ForestListState
            isLoading={threads.isLoading}
            isError={threads.isError}
            onRetry={() => void threads.refetch()}
            isEmpty={list.length === 0}
            empty={t("workspace:notebook.chat.threadsEmpty")}
          >
            <ThreadList
              threads={list}
              activeId={threadId}
              onSelect={onThreadChange}
            />
          </ForestListState>
        </aside>
        <div className="flex min-w-0 flex-col gap-4">
          {threadId ? (
            <ThreadView
              workspaceId={workspaceId}
              threadId={threadId}
              pendingQuestion={pending}
              canDelete={canManageSettings()}
              onDeleted={() => onThreadChange(undefined)}
            />
          ) : pending ? (
            <div className="flex flex-col gap-3">
              <PendingQuestion question={pending} />
            </div>
          ) : (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
              {t("workspace:notebook.chat.pickOrAsk")}
            </p>
          )}
          <AskForm
            key={threadId ?? "new"}
            placeholder={
              threadId
                ? t("workspace:notebook.chat.followUpPlaceholder")
                : t("workspace:notebook.chat.placeholder")
            }
            pending={ask.isPending}
            onAsk={onAsk}
          />
        </div>
      </div>
    </div>
  );
}
