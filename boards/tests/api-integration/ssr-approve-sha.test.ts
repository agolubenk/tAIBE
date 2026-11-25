import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db from "../../apps/api/src/database";
import {
  ssrEntityTable,
  ssrVersionTable,
} from "../../apps/api/src/database/ssr-schema";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";

// TB-88: a single approve or reject names the bytes the owner saw in the diff.
// The sync rewrites an open draft in place under the same id, so between the
// diff and the click the id alone could point at other bytes.
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

describe("API integration: SSR single decision is bound to the diff bytes", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function setup() {
    const forest = await createForest();
    const ws = forest.workspace.id;
    const path = ".claude/skills/omega/NOTE.md";
    const commitSha = "7071727374757677787970717273747576777879";
    const sync = (text: string) =>
      forest.ownerApi("POST", `/ssr/${ws}/sync`, {
        commitSha,
        files: [{ path, sha256: sha256(text), content: text }],
      });
    const first = await sync("bytes the owner saw");
    expect(first.status).toBe(200);
    const [draft] = first.body.created;
    if (!draft) throw new Error("the first sync made no draft");
    const [row] = await db
      .select()
      .from(ssrVersionTable)
      .where(eq(ssrVersionTable.id, draft.versionId));
    if (!row) throw new Error("no draft row");
    const entityPath = `/ssr/${ws}/entities/${row.entityId}`;
    const diff = () =>
      forest.ownerApi("GET", `${entityPath}/diff?from=latest&to=${row.number}`);
    const decide = (action: "approve" | "reject", body: unknown) =>
      forest.ownerApi("POST", `${entityPath}/${action}`, body);
    const status = async () => {
      const [current] = await db
        .select()
        .from(ssrVersionTable)
        .where(eq(ssrVersionTable.id, draft.versionId));
      return current;
    };
    return {
      forest,
      sync,
      diff,
      decide,
      status,
      versionId: draft.versionId,
      entityId: row.entityId,
    };
  }

  it("refuses bytes the sync replaced after the diff, then approves what the fresh diff shows", async () => {
    const { sync, diff, decide, status, versionId } = await setup();

    const seen = await diff();
    expect(seen.status).toBe(200);
    expect(seen.body.toVersionId).toBe(versionId);
    const seenSha: string = seen.body.toBlobSha;
    expect(seenSha).toMatch(/^[0-9a-f]{64}$/);

    // The sync replaces the open draft in place: same id, other bytes.
    const replaced = await sync("bytes nobody looked at");
    expect(replaced.status).toBe(200);
    const after = await status();
    expect(after?.status).toBe("draft");
    expect(after?.blobSha).not.toBe(seenSha);

    for (const action of ["approve", "reject"] as const) {
      const stale = await decide(action, { versionId, blobSha: seenSha });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("SSR_DRAFT_CHANGED");
    }
    // Nothing was decided: still the same open draft with the newer bytes.
    expect(await status()).toMatchObject({
      status: "draft",
      blobSha: after?.blobSha,
      approvedBy: null,
    });

    const fresh = await diff();
    expect(fresh.body.toBlobSha).toBe(after?.blobSha);
    const approved = await decide("approve", {
      versionId,
      blobSha: fresh.body.toBlobSha,
    });
    expect(approved.status).toBe(200);
    expect((await status())?.status).toBe("latest");

    // A decided version is not an open draft: a plain conflict, not "changed".
    const again = await decide("approve", {
      versionId,
      blobSha: fresh.body.toBlobSha,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("CONFLICT");
  });

  it("a refused approve keeps the previous latest live: the supersede rolls back", async () => {
    const { decide, diff, status, versionId, entityId } = await setup();
    const first = await diff();
    expect(
      (await decide("approve", { versionId, blobSha: first.body.toBlobSha }))
        .status,
    ).toBe(200);

    // A second draft on top of the live version (sync auto-bumps a live
    // entity, so this one is written directly, as a proposal would be).
    const live = await status();
    if (!live) throw new Error("no live version");
    const proposalSha = sha256("proposal bytes");
    const [proposal] = await db
      .insert(ssrVersionTable)
      .values({
        entityId,
        number: 2,
        blobSha: proposalSha,
        files: live.files,
        status: "draft",
        origin: "sync",
      })
      .returning({ id: ssrVersionTable.id });
    if (!proposal) throw new Error("no proposal row");

    const stale = await decide("approve", {
      versionId: proposal.id,
      blobSha: sha256("bytes the owner saw earlier"),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("SSR_DRAFT_CHANGED");
    const versions = async () =>
      db
        .select({
          number: ssrVersionTable.number,
          status: ssrVersionTable.status,
        })
        .from(ssrVersionTable)
        .where(eq(ssrVersionTable.entityId, entityId))
        .orderBy(ssrVersionTable.number);
    const latestOf = async () => {
      const [entity] = await db
        .select({ latest: ssrEntityTable.latestVersionId })
        .from(ssrEntityTable)
        .where(eq(ssrEntityTable.id, entityId));
      return entity?.latest;
    };
    expect(await versions()).toEqual([
      { number: 1, status: "latest" },
      { number: 2, status: "draft" },
    ]);
    expect(await latestOf()).toBe(versionId);

    const approved = await decide("approve", {
      versionId: proposal.id,
      blobSha: proposalSha,
    });
    expect(approved.status).toBe(200);
    expect(await versions()).toEqual([
      { number: 1, status: "superseded" },
      { number: 2, status: "latest" },
    ]);
    expect(await latestOf()).toBe(proposal.id);
  });

  it("rejects with the sha from the diff and refuses a body without one", async () => {
    const { diff, decide, status, versionId } = await setup();

    const missing = await decide("reject", { versionId });
    expect(missing.status).toBe(400);
    expect((await status())?.status).toBe("draft");

    const seen = await diff();
    const rejected = await decide("reject", {
      versionId,
      blobSha: seen.body.toBlobSha,
    });
    expect(rejected.status).toBe(200);
    expect((await status())?.status).toBe("rejected");
  });

  it("an agent key is refused before the body is read", async () => {
    const { forest, status, versionId } = await setup();
    const [row] = await db
      .select()
      .from(ssrVersionTable)
      .where(eq(ssrVersionTable.id, versionId));
    if (!row) throw new Error("no draft row");
    const viaKey = await forest.agentApi(
      "POST",
      `/ssr/${forest.workspace.id}/entities/${row.entityId}/approve`,
      { versionId },
    );
    expect(viaKey.status).toBe(403);
    expect((await status())?.status).toBe("draft");
  });
});
