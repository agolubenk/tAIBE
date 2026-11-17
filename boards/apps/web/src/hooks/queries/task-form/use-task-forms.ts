import { useQuery } from "@tanstack/react-query";
import getTaskForms from "@/fetchers/task-form/get-task-forms";

export const taskFormsKey = (taskId: string) => ["task-forms", taskId];

/**
 * The forms attached to a task (TB-173). The task page calls it next to its
 * task query, so both requests start together; the card's forms slot reads
 * the same entry without a second request. Saves keep the entry current, so
 * a minute of cache is safe; a form changed in another tab answers 409.
 */
function useTaskForms(
  taskId: string,
  { retryOnMount = true }: { retryOnMount?: boolean } = {},
) {
  return useQuery({
    queryKey: taskFormsKey(taskId),
    queryFn: () => getTaskForms(taskId),
    enabled: Boolean(taskId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retryOnMount,
  });
}

export default useTaskForms;
