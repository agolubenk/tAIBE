import { describe, expect, it } from "vite-plus/test";
import type { SsrDraftMatch } from "@/fetchers/ssr/ssr-fetchers";
import { groupBySource, MAX_BATCH, planBatch } from "./approve-matching-plan";

const draft = (index: number, workspaceId: string | null): SsrDraftMatch => ({
  entityId: `e-${index}`,
  versionId: `v-${index}`,
  path: `skills/${index}`,
  kind: "skill",
  blobSha: `sha-${index}`,
  match: workspaceId
    ? {
        workspaceId,
        workspaceName: `name-${workspaceId}`,
        versionId: "t",
        number: 1,
      }
    : null,
});

describe("planBatch", () => {
  it("takes the first 200 matches and leaves the rest for the next batch", () => {
    const drafts = [
      ...Array.from({ length: 250 }, (_, i) => draft(i, "ws-a")),
      draft(999, null),
    ];
    const plan = planBatch(drafts);
    expect(plan.matching).toHaveLength(250);
    expect(plan.batch).toHaveLength(MAX_BATCH);
    expect(plan.batch[0]?.versionId).toBe("v-0");
    expect(plan.later).toBe(50);
    expect(plan.review.map((d) => d.versionId)).toEqual(["v-999"]);
  });
});

describe("groupBySource", () => {
  it("groups matched drafts by the workspace that approved them, in order", () => {
    const { batch } = planBatch([
      draft(1, "ws-a"),
      draft(2, "ws-b"),
      draft(3, "ws-a"),
    ]);
    expect(
      groupBySource(batch).map((group) => [
        group.workspaceName,
        group.drafts.map((d) => d.versionId),
      ]),
    ).toEqual([
      ["name-ws-a", ["v-1", "v-3"]],
      ["name-ws-b", ["v-2"]],
    ]);
  });
});
