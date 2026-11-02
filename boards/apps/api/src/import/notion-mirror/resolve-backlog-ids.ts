// backlog_id is unique per workspace, and Notion has duplicates (9 groups on
// 30.10, all inside one database). One page per value keeps the ID in
// card_meta; the others carry it in the body's footer, so nothing is lost.
export type BacklogCandidate = {
  key: string;
  pageId: string;
  createdTime: string;
  backlogId: string | null;
};

export type BacklogGroup = {
  value: string;
  holder: string | null;
  footer: string[];
};

export type BacklogResolution = {
  // Task keys whose ID goes to the footer instead of card_meta.
  dropped: Set<string>;
  // Every value more than one page has, or a card outside the mirror holds.
  groups: BacklogGroup[];
};

export function resolveBacklogIds(
  candidates: readonly BacklogCandidate[],
  held: {
    // Values a card outside this mirror already holds: it keeps them.
    outside: ReadonlySet<string>;
    // Value → page id of the mirrored card holding it now. A normal pass
    // leaves the ID there: moving it would rewrite a card whose body was
    // not read. Empty under force, which settles every group afresh.
    byPage: ReadonlyMap<string, string>;
  },
): BacklogResolution {
  const byValue = new Map<string, BacklogCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.backlogId === null) continue;
    const list = byValue.get(candidate.backlogId) ?? [];
    list.push(candidate);
    byValue.set(candidate.backlogId, list);
  }

  const dropped = new Set<string>();
  const groups: BacklogGroup[] = [];
  for (const [value, list] of byValue) {
    const outside = held.outside.has(value);
    if (list.length === 1 && !outside) continue;
    const current = held.byPage.get(value);
    const ordered = [...list].sort(
      (a, b) =>
        Number(b.pageId === current) - Number(a.pageId === current) ||
        a.createdTime.localeCompare(b.createdTime) ||
        a.pageId.localeCompare(b.pageId),
    );
    const holder = outside ? null : (ordered[0] ?? null);
    const rest = ordered.filter((candidate) => candidate !== holder);
    for (const candidate of rest) dropped.add(candidate.key);
    groups.push({
      value,
      holder: holder?.pageId ?? null,
      footer: rest.map(({ pageId }) => pageId),
    });
  }
  return { dropped, groups };
}

// The run's warnings: which IDs stayed in a footer, on how many cards, then
// each group with its holder and the pages that carry the ID in the footer
// (role 1, 30.10).
export function backlogWarnings(groups: readonly BacklogGroup[]): string[] {
  const moved = groups.filter(({ footer }) => footer.length > 0);
  if (moved.length === 0) return [];
  const cards = moved.reduce((sum, { footer }) => sum + footer.length, 0);
  return [
    `Kept a Backlog ID another card holds in the footer of ${cards === 1 ? "1 card" : `${cards} cards`}: ${moved.map(({ value }) => value).join(", ")}.`,
    ...moved.map(
      ({ value, holder, footer }) =>
        `Backlog ID ${value}: held by ${holder ? `page ${holder}` : "a card outside this mirror"}; in the footer: ${footer.join(", ")}.`,
    ),
  ];
}
