import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import useTaskForms, {
  taskFormsKey,
} from "@/hooks/queries/task-form/use-task-forms";
import { TaskFormBlock } from "./task-form-block";

// TB-173 web (a): the forms of a task, loaded as a lazy chunk only when the
// task has forms or its list did not load, so a card without forms pays
// nothing for them. It reads the list of the slot's query: no second request.
// The slot mounts it after a failed list too, so its observer must not retry
// on mount: the user sees the error and decides to retry.

export default function TaskFormsSection({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const headingId = useId();
  const { data: forms, isError, isFetching, refetch } = useTaskForms(taskId, {
    retryOnMount: false,
  });
  // Wait for the newest list once; after that the blocks stay mounted, so a
  // later refetch never drops answers that are being typed.
  const [shown, setShown] = useState(false);
  // A reload remounts the blocks, so they start from the server copy.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(async () => {
    await queryClient.refetchQueries({
      queryKey: taskFormsKey(taskId),
      exact: true,
    });
    setGeneration((value) => value + 1);
  }, [queryClient, taskId]);

  if (!forms) {
    if (!isError) return null;
    return (
      <div className="mt-6 flex items-center gap-2" role="alert">
        <p className="text-muted-foreground text-sm">
          {t("tasks:forms.loadError")}
        </p>
        <Button onClick={() => void refetch()} size="xs" variant="outline">
          {t("tasks:forms.retry")}
        </Button>
      </div>
    );
  }
  if (forms.length === 0 || (isFetching && !shown)) return null;
  if (!shown) setShown(true);

  return (
    <section aria-labelledby={headingId} className="mt-6 flex flex-col gap-3">
      <h2 className="font-medium text-sm" id={headingId}>
        {t("tasks:forms.title")}
      </h2>
      {forms.map((form) => (
        <TaskFormBlock
          form={form}
          key={`${form.id}:${generation}`}
          onReload={() => void reload()}
          taskId={taskId}
        />
      ))}
    </section>
  );
}
