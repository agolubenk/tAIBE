import type { SsrDraftMatch } from "@/fetchers/ssr/ssr-fetchers";

// The server takes at most 200 drafts per batch; the next click takes the
// next 200, since approved drafts leave the list.
export const MAX_BATCH = 200;

export type MatchedDraft = SsrDraftMatch & {
  match: NonNullable<SsrDraftMatch["match"]>;
};

export type SourceGroup = {
  workspaceId: string;
  workspaceName: string;
  drafts: MatchedDraft[];
};

export function planBatch(drafts: SsrDraftMatch[]) {
  const matching = drafts.filter((draft): draft is MatchedDraft =>
    Boolean(draft.match),
  );
  const batch = matching.slice(0, MAX_BATCH);
  return {
    matching,
    batch,
    // Left for per-item review with the diff.
    review: drafts.filter((draft) => !draft.match),
    later: matching.length - batch.length,
  };
}

export function groupBySource(drafts: MatchedDraft[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const draft of drafts) {
    const { workspaceId, workspaceName } = draft.match;
    const group = groups.get(workspaceId) ?? {
      workspaceId,
      workspaceName,
      drafts: [],
    };
    group.drafts.push(draft);
    groups.set(workspaceId, group);
  }
  return [...groups.values()];
}
