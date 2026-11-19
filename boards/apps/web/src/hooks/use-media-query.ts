import { useCallback, useSyncExternalStore } from "react";

/**
 * The range below Tailwind `lg`, the same query as its `max-lg:` variant.
 * rem, not px: with a browser font other than 16px, 64rem is not 1024px.
 */
export const BELOW_LG_QUERY = "(width < 64rem)";

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
