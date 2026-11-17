import { useBelowLg } from "@/hooks/use-media-query";

export function useCompactBar() {
  return useBelowLg();
}
