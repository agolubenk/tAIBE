import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskForm } from "@/fetchers/task-form/get-task-forms";
import { taskFormsKey } from "@/hooks/queries/task-form/use-task-forms";
import { TaskFormBlock } from "./task-form-block";

// TB-173 web (a): the forms of a task, loaded as a lazy chunk only when the
// task has forms, so a card without forms pays nothing for them.

type Props = { taskId: string; forms: TaskForm[] };

export default function TaskFormsSection({ taskId, forms }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const headingId = useId();
  // A reload remounts the blocks, so they start from the server copy.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(async () => {
    await queryClient.refetchQueries({
      queryKey: taskFormsKey(taskId),
      exact: true,
    });
    setGeneration((value) => value + 1);
  }, [queryClient, taskId]);

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
