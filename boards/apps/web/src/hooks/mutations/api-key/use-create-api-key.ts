import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { throwIfNotFresh } from "@/lib/reauth/reauth-errors";
import type {
  CreateApiKeyClientRequest,
  CreateApiKeyResponse,
} from "@/types/api-key";

function useCreateApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateApiKeyClientRequest) => {
      const result = await authClient.apiKey.create({
        name: data.name,
        expiresIn: data.expiresIn,
        prefix: data.prefix,
        metadata: data.metadata,
      });

      if (result.error) {
        // TB-31 R-5: the key outlives a password reset, so it needs a fresh sign-in.
        throwIfNotFresh(result.error);
        throw new Error(result.error.message);
      }

      return result.data as CreateApiKeyResponse;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
}

export default useCreateApiKey;
