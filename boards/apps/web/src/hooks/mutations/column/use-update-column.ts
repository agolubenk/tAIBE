import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateColumn from "@/fetchers/column/update-column";
import { invalidateProjectTaskDetails } from "@/lib/invalidate-project-task-details";

export function useUpdateColumn() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      projectId: string;
      data: {
        name?: string;
        icon?: string | null;
        color?: string | null;
        isFinal?: boolean;
      };
    }) => updateColumn(id, data),
    onSuccess: async (_, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["columns", variables.projectId],
          refetchType: "all",
        }),
        queryClient.invalidateQueries({
          queryKey: ["tasks", variables.projectId],
          refetchType: "all",
        }),
        // The broadcast skips this window; its own open card needs the new
        // completedAt too (TB-30).
        variables.data.isFinal !== undefined &&
          invalidateProjectTaskDetails(queryClient, variables.projectId),
      ]);
    },
  });
}
