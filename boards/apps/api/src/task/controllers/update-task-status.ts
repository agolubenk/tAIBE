import { publishEvent } from "../../events";
import { applyTaskStatusInTx } from "./apply-task-status";
import { publishTaskMutation } from "./task-mutation-effects";
import { withLockedTask } from "./with-locked-task";

async function updateTaskStatus({
  id,
  status,
  currentUserId,
}: {
  id: string;
  status: string;
  currentUserId: string;
}) {
  const { before: existingTask, after: updatedTask } = await withLockedTask(
    id,
    (tx, existingTask) => applyTaskStatusInTx(tx, existingTask, status),
  );

  await publishTaskMutation(existingTask, updatedTask, currentUserId, {
    fields: ["status"],
  });

  if (
    existingTask.status === updatedTask.status &&
    existingTask.columnId !== updatedTask.columnId
  )
    await publishEvent("task.updated", {
      taskId: updatedTask.id,
      projectId: updatedTask.projectId,
      userId: currentUserId,
    });

  return updatedTask;
}

export default updateTaskStatus;
