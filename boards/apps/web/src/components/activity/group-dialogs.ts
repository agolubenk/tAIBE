// R-026, AC-010: comments of linked sessions carry
// { dialog: { groupKey, fencingToken, session, open } } (apps/api/src/forest/dialog).
// The feed shows each dialog as one block at the place of its first message.
export type DialogInfo = { key: string; session: string; open: boolean };

export function readDialog(eventData: unknown): DialogInfo | null {
  if (!eventData || typeof eventData !== "object") return null;
  const dialog = (eventData as { dialog?: unknown }).dialog;
  if (!dialog || typeof dialog !== "object") return null;
  const { groupKey, fencingToken, session, open } = dialog as Record<
    string,
    unknown
  >;
  if (
    typeof groupKey !== "string" ||
    typeof fencingToken !== "number" ||
    typeof session !== "string"
  ) {
    return null;
  }
  return { key: `${groupKey}#${fencingToken}`, session, open: open === true };
}

export type DialogEntry<T> = {
  kind: "dialog";
  key: string;
  open: boolean;
  // In the order the sessions first spoke.
  sessions: string[];
  messages: T[];
};

export type FeedEntry<T> = { kind: "activity"; activity: T } | DialogEntry<T>;

export function groupDialogs<T extends { eventData?: unknown }>(
  chronological: T[],
): FeedEntry<T>[] {
  const entries: FeedEntry<T>[] = [];
  const dialogs = new Map<string, DialogEntry<T>>();
  for (const activity of chronological) {
    const dialog = readDialog(activity.eventData);
    if (!dialog) {
      entries.push({ kind: "activity", activity });
      continue;
    }
    let block = dialogs.get(dialog.key);
    if (!block) {
      block = {
        kind: "dialog",
        key: dialog.key,
        open: dialog.open,
        sessions: [],
        messages: [],
      };
      dialogs.set(dialog.key, block);
      entries.push(block);
    }
    if (!block.sessions.includes(dialog.session)) {
      block.sessions.push(dialog.session);
    }
    block.messages.push(activity);
  }
  return entries;
}
