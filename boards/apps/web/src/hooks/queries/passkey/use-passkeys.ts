import { useQuery } from "@tanstack/react-query";
import { listPasskeys } from "@/lib/passkey/passkey-api";

export const PASSKEYS_QUERY_KEY = ["passkeys"] as const;

/** TB-31 R-6: the signed-in person's passkeys, newest first. */
export function usePasskeys() {
  return useQuery({ queryKey: PASSKEYS_QUERY_KEY, queryFn: listPasskeys });
}
