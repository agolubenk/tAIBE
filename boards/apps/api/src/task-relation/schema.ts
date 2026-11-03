import { z } from "../openapi";

export const taskIdParam = z.object({ taskId: z.string() });

export const taskRelationParam = z.object({ id: z.string() });

export const createTaskRelationBody = z.object({
  sourceTaskId: z.string(),
  targetTaskId: z.string(),
  relationType: z.enum(["subtask", "blocks", "related"]),
  replaceParent: z.boolean().optional().openapi({
    description:
      "Subtask only: a task has one parent, so a second one is refused (409). Set true to move the target from its current parent in one step.",
  }),
});
