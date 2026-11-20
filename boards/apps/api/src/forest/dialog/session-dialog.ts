import type { StoredLease } from "../lease/decide-acquire";

// R-026, AC-010 (owner, 01.11; coordinator's forks, 13.11): linked sessions
// share one lease under a groupKey and talk on the card. A comment of a
// session of that group belongs to the group's dialog. One dialog is one lease
// episode — the groupKey and its fencing token — so a later lease of the same
// group starts a new dialog. `session` is the speaking session's name (agent
// name or session label), so the feed can tell the sessions apart.
export type DialogMark = {
  groupKey: string;
  fencingToken: number;
  session: string;
};
export type DialogActor = { id: string; name: string };

export type DialogLease = Pick<
  StoredLease,
  "holderId" | "groupKey" | "fencingToken" | "expiresAt"
>;

function isLive(lease: DialogLease, now: Date) {
  return lease.expiresAt.getTime() > now.getTime();
}

// The holder of a live group lease, or a session that sends its groupKey.
export function decideDialogMark(
  lease: DialogLease | null,
  actor: DialogActor,
  groupHeader: string | null,
  now: Date,
): DialogMark | null {
  if (!lease || lease.groupKey === null || !isLive(lease, now)) return null;
  const member = lease.holderId === actor.id || groupHeader === lease.groupKey;
  return member
    ? {
        groupKey: lease.groupKey,
        fencingToken: lease.fencingToken,
        session: actor.name,
      }
    : null;
}

// Open while its lease episode lives and the card is still in work. The lease
// ending (released or lapsed) or the card going to review or a final column
// archives it; an archived dialog stays readable.
export function isDialogOpen(
  mark: Pick<DialogMark, "groupKey" | "fencingToken">,
  lease: DialogLease | null,
  card: { inWork: boolean },
  now: Date,
) {
  return (
    card.inWork &&
    lease !== null &&
    lease.groupKey === mark.groupKey &&
    lease.fencingToken === mark.fencingToken &&
    isLive(lease, now)
  );
}

// Only a comment carries a dialog mark: the server writes it in createComment.
// A mark on any other activity type is not trusted (TB-11 backend lens, #203).
export function dialogMarkOf(activity: {
  type: string;
  eventData: unknown;
}): DialogMark | null {
  return activity.type === "comment"
    ? readDialogMark(activity.eventData)
    : null;
}

// The generic activity route takes eventData from the client: drop a forged
// dialog mark before the write. The root issue (any type from the client) is
// TB-29.
export function withoutDialogMark(
  eventData: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!eventData || !("dialog" in eventData)) return eventData;
  const { dialog: _forged, ...rest } = eventData;
  return rest;
}

export function readDialogMark(eventData: unknown): DialogMark | null {
  if (!eventData || typeof eventData !== "object") return null;
  const dialog = (eventData as { dialog?: unknown }).dialog;
  if (!dialog || typeof dialog !== "object") return null;
  const { groupKey, fencingToken, session } = dialog as Record<string, unknown>;
  return typeof groupKey === "string" &&
    typeof fencingToken === "number" &&
    typeof session === "string"
    ? { groupKey, fencingToken, session }
    : null;
}
