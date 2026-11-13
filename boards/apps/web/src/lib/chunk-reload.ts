// A chunk missing after a deploy: the open tab still names the old files.
// The same test and sessionStorage key as `lazyRouteComponent` of
// @tanstack/react-router, so a route chunk and a part chunk missing after one
// deploy reload the page only once.
const SCRIPT_MISSING = [
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
];
// Vite's preload helper, when the chunk's CSS is gone (TB-127).
const CSS_MISSING = "Unable to preload CSS";

function isChunkMissing(error: Error) {
  return [...SCRIPT_MISSING, CSS_MISSING].some((prefix) =>
    error.message.startsWith(prefix),
  );
}

export function reloadOnce(error: Error): boolean {
  if (!isChunkMissing(error)) return false;
  const key = `tanstack_router_reload:${error.message}`;
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");
  } catch {
    // Storage is off (private mode): show the retry, do not risk a reload loop.
    return false;
  }
  window.location.reload();
  return true;
}

type PreloadErrorEvent = Event & { payload?: unknown };

// The router knows a missing script but not missing CSS: the task page route
// loads the CSS of task-details-content too. Only CSS is handled here — a
// script error goes on to the router or lazyPart, which reload with the same
// key; cancelling it here would let the import resolve without its module.
export function handleCssPreloadError(event: PreloadErrorEvent) {
  const error = event.payload;
  if (!(error instanceof Error) || !error.message.startsWith(CSS_MISSING)) {
    return;
  }
  // Reloading: let the import go on without the CSS until the page reloads.
  // The same error after that reload goes on to the retry or error screen.
  if (reloadOnce(error)) event.preventDefault();
}

export function installCssPreloadReload(target: Window = window) {
  target.addEventListener("vite:preloadError", handleCssPreloadError);
}
