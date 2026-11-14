import { linkRefusal } from "./link-fetch";

// TB-132: a link fetch holds up to 2 MB and 10 s of this process. A workspace
// gets two at a time and the process eight (at most 16 MB of bodies, however
// many workspaces a user creates). Beyond that the fetch is refused at once
// with LINK_BUSY instead of a queue, so no request hangs and nothing piles up
// in memory. The counts live in this process: with several API processes each
// one keeps its own limits.
export const LINK_FETCHES_PER_WORKSPACE = 2;
export const LINK_FETCHES_PER_PROCESS = 8;

const inFlight = new Map<string, number>();
let total = 0;

export async function withLinkSlot<T>(
  workspaceId: string,
  run: () => Promise<T>,
): Promise<T> {
  const used = inFlight.get(workspaceId) ?? 0;
  if (total >= LINK_FETCHES_PER_PROCESS || used >= LINK_FETCHES_PER_WORKSPACE) {
    throw linkRefusal(
      429,
      "LINK_BUSY",
      "Too many links are loading right now. Try again in a few seconds.",
    );
  }
  inFlight.set(workspaceId, used + 1);
  total += 1;
  try {
    return await run();
  } finally {
    total -= 1;
    const left = (inFlight.get(workspaceId) ?? 1) - 1;
    if (left > 0) inFlight.set(workspaceId, left);
    else inFlight.delete(workspaceId);
  }
}

export function linkFetchesInFlight(workspaceId?: string) {
  return workspaceId === undefined ? total : (inFlight.get(workspaceId) ?? 0);
}
