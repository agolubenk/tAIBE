import { useCallback, useSyncExternalStore } from "react";

/** Tailwind `lg` starts at 64rem = 1024px; this is the range below it. */
export const BELOW_LG_QUERY = "(max-width: 1023px)";

const hasMatchMedia = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function";

/**
 * Live result of a CSS media query. Follows resize and rotation. Without
 * `matchMedia` (server, old test environments) the answer is `fallback`.
 */
export function useMediaQuery(query: string, fallback = false) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = () =>
    hasMatchMedia() ? window.matchMedia(query).matches : fallback;

  return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
}

/** True below Tailwind `lg`: where `lg:` columns are hidden. */
export function useBelowLg() {
  return useMediaQuery(BELOW_LG_QUERY);
}
