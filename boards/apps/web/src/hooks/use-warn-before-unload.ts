import { useEffect } from "react";

// `window` holds one listener for all users. A listener per user is not
// enough: the build hoists a handler that captures nothing to module level,
// `addEventListener` adds the same function only once, and then the first
// user to stop would remove the warning of all the others.
let users = 0;

function onBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  // Legacy support: Chrome and Edge before 119 ask only when this is set.
  event.returnValue = true;
}

/**
 * While `active`, closing or reloading the tab makes the browser ask first.
 * The browser shows its own text; a page cannot set it. Navigation inside
 * the app does not fire `beforeunload`.
 */
export function useWarnBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    users += 1;
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      users -= 1;
      if (users === 0) {
        window.removeEventListener("beforeunload", onBeforeUnload);
      }
    };
  }, [active]);
}
