import { linkRefusal } from "./link-fetch";

// TB-132: a link fetch holds up to 2 MB and 10 s of this process. A workspace
// gets two at a time; the third is refused at once with LINK_BUSY instead of a
// queue, so no request hangs and nothing piles up in memory. The count lives in
// this process: with several API processes each one keeps its own two.
export const LINK_FETCHES_PER_WORKSPACE = 2;

const inFlight = new Map<string, number>();

export async function withLinkSlot<T>(
  workspaceId: string,
  run: () => Promise<T>,
  limit = LINK_FETCHES_PER_WORKSPACE,
): Promise<T> {
  const used = inFlight.get(workspaceId) ?? 0;
  if (used >= limit) {
    throw linkRefusal(
      429,
      "LINK_BUSY",
      "Other links are still loading in this workspace. Try again in a few seconds.",
    );
  }
  inFlight.set(workspaceId, used + 1);
  try {
    return await run();
  } finally {
    const left = (inFlight.get(workspaceId) ?? 1) - 1;
    if (left > 0) inFlight.set(workspaceId, left);
    else inFlight.delete(workspaceId);
  }
}

export function linkFetchesInFlight(workspaceId: string) {
  return inFlight.get(workspaceId) ?? 0;
}
