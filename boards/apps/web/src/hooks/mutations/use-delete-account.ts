import { useMutation } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { throwIfNotFresh } from "@/lib/reauth/reauth-errors";

function useDeleteAccount() {
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await authClient.deleteUser();

      if (error) {
        // TB-31 R-5: the window confirms who it is instead of «sign in again».
        throwIfNotFresh(error);
        throw new Error(error.message || "Failed to delete account");
      }

      return data;
    },
  });
}

export default useDeleteAccount;
