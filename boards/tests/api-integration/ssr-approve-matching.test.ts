import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  ssrEntityTable,
  ssrVersionTable,
} from "../../apps/api/src/database/ssr-schema";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";
import { createForest } from "./helpers/forest";

// Approve-matching (owner action): a draft is approved in bulk only when the
// server proves the same path + blob sha was already approved in a workspace
// the owner can read. A workspace the owner cannot read never vouches and is
// never revealed.
const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

type SeedVersion = {
  number: number;
  text: string;
  status: "latest" | "superseded" | "draft" | "rejected";
  origin?: "sync" | "owner" | "rollback";
  approved?: boolean;
};

async function seedEntity(
  workspaceId: string,
  path: string,
  versions: SeedVersion[],
) {
  const [entity] = await db
    .insert(ssrEntityTable)
    .values({ workspaceId, kind: "skill", name: path, path })
    .returning();
  if (!entity) throw new Error("entity insert returned nothing");
  const rows = await db
    .insert(ssrVersionTable)
    .values(
      versions.map((version) => ({
        entityId: entity.id,
        number: version.number,
        blobSha: sha(version.text),
        files: [],
        status: version.status,
        origin: version.origin ?? "owner",
        approvedAt: version.approved ? new Date() : null,
        approvedBy: version.approved ? "someone" : null,
      })),
    )
    .returning();
  const latest = rows.find((row) => row.status === "latest");
  if (latest) {
    await db
      .update(ssrEntityTable)
      .set({ latestVersionId: latest.id })
      .where(eq(ssrEntityTable.id, entity.id));
  }
  const byNumber = new Map(rows.map((row) => [row.number, row.id]));
  const id = (number: number) => {
    const versionId = byNumber.get(number);
    if (!versionId) throw new Error(`no v${number} for ${path}`);
    return versionId;
  };
  return { entityId: entity.id, id };
}

async function setup() {
  const forest = await createForest();
  const here = forest.workspace.id;

  // A second workspace the owner belongs to: the approved source.
  const [source] = await db
    .insert(schema.workspaceTable)
    .values({
      id: "ws-source",
      name: "aiBoards&eval",
      slug: "ws-source",
      createdAt: new Date(),
    })
    .returning();
  if (!source) throw new Error("source workspace insert returned nothing");
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: source.id,
    userId: forest.ownerId,
    role: "owner",
    joinedAt: new Date(),
  });
  // A workspace of somebody else: the owner cannot read it.
  const { workspace: foreign } = await createWorkspaceMember({
    workspaceName: "Hidden workspace",
    role: "owner",
  });

  // Here: drafts waiting for the owner.
  const p1 = await seedEntity(here, "skills/p1", [
    { number: 1, text: "old", status: "latest", approved: true },
    { number: 2, text: "one", status: "draft", origin: "sync" },
  ]);
  const p2 = await seedEntity(here, "skills/p2", [
    { number: 1, text: "two", status: "draft", origin: "sync" },
  ]);
  const p3 = await seedEntity(here, "skills/p3", [
    { number: 1, text: "three", status: "draft", origin: "sync" },
  ]);
  const p4 = await seedEntity(here, "skills/p4", [
    { number: 1, text: "four", status: "draft", origin: "sync" },
  ]);
  const p6 = await seedEntity(here, "skills/p6", [
    { number: 1, text: "six", status: "draft", origin: "sync" },
  ]);

  // Source: what the owner approved elsewhere.
  await seedEntity(source.id, "skills/p1", [
    { number: 1, text: "zero", status: "superseded", approved: true },
    { number: 2, text: "one", status: "latest", approved: true },
  ]);
  // A sync auto-bump counts as approved (Q-014).
  await seedEntity(source.id, "skills/p2", [
    { number: 1, text: "two", status: "superseded", origin: "sync" },
    { number: 2, text: "two-b", status: "latest", origin: "sync" },
  ]);
  // Drafts and rejected versions never vouch.
  await seedEntity(source.id, "skills/p3", [
    { number: 1, text: "three", status: "rejected", approved: true },
    { number: 2, text: "three", status: "draft", origin: "sync" },
  ]);
  // Same path with other bytes, same bytes at another path: no match.
  await seedEntity(source.id, "skills/p4", [
    { number: 1, text: "four-b", status: "latest", approved: true },
  ]);
  await seedEntity(source.id, "skills/p5", [
    { number: 1, text: "four", status: "latest", approved: true },
  ]);
  // Only the unreadable workspace holds p6's bytes.
  await seedEntity(foreign.id, "skills/p6", [
    { number: 1, text: "six", status: "latest", approved: true },
  ]);

  return {
    forest,
    here,
    source,
    foreign,
    drafts: {
      p1: p1.id(2),
      p2: p2.id(1),
      p3: p3.id(1),
      p4: p4.id(1),
      p6: p6.id(1),
    },
    p1,
  };
}

async function statuses(ids: string[]) {
  const rows = await db
    .select({ id: ssrVersionTable.id, status: ssrVersionTable.status })
    .from(ssrVersionTable)
    .where(inArray(ssrVersionTable.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

describe("API integration: SSR approve-matching", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("lists only same-path, same-sha approved twins in readable workspaces", async () => {
    const { forest, here, source, foreign, drafts } = await setup();
    const response = await forest.ownerApi(
      "GET",
      `/ssr/${here}/drafts/matches`,
    );
    expect(response.status).toBe(200);
    const byVersion = new Map(
      response.body.drafts.map(
        (draft: { versionId: string; match: unknown }) => [
          draft.versionId,
          draft.match,
        ],
      ),
    );
    expect(response.body.drafts).toHaveLength(5);
    expect(byVersion.get(drafts.p1)).toEqual(
      expect.objectContaining({
        workspaceId: source.id,
        workspaceName: "aiBoards&eval",
        number: 2,
      }),
    );
    expect(byVersion.get(drafts.p2)).toEqual(
      expect.objectContaining({ workspaceId: source.id, number: 1 }),
    );
    expect(byVersion.get(drafts.p3)).toBeNull();
    expect(byVersion.get(drafts.p4)).toBeNull();
    // No leak: the unreadable workspace neither matches nor shows up.
    expect(byVersion.get(drafts.p6)).toBeNull();
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(foreign.id);
    expect(text).not.toContain("Hidden workspace");
  });

  it("approves every listed draft in one transaction", async () => {
    const { forest, here, drafts, p1 } = await setup();
    const response = await forest.ownerApi(
      "POST",
      `/ssr/${here}/drafts/approve-matching`,
      { versionIds: [drafts.p1, drafts.p2] },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      approved: 2,
      versionIds: [drafts.p1, drafts.p2],
    });

    expect(await statuses([p1.id(1), drafts.p1, drafts.p2])).toEqual({
      [p1.id(1)]: "superseded",
      [drafts.p1]: "latest",
      [drafts.p2]: "latest",
    });
    const [approved] = await db
      .select()
      .from(ssrVersionTable)
      .where(eq(ssrVersionTable.id, drafts.p1));
    expect(approved?.approvedBy).toBe(forest.ownerId);
    expect(approved?.approvedAt).toBeInstanceOf(Date);
    const [entity] = await db
      .select()
      .from(ssrEntityTable)
      .where(eq(ssrEntityTable.id, p1.entityId));
    expect(entity?.latestVersionId).toBe(drafts.p1);
    expect(entity?.status).toBe("active");

    // The approved drafts are no longer open: the list shrinks to the rest.
    const after = await forest.ownerApi("GET", `/ssr/${here}/drafts/matches`);
    expect(after.body.drafts).toHaveLength(3);
  });

  it("refuses the whole batch with 409 when any id does not match", async () => {
    const { forest, here, drafts, p1 } = await setup();
    const cases = [
      [drafts.p3], // no approved twin
      [p1.id(1)], // not a draft
      [drafts.p6], // twin only in an unreadable workspace
      ["no-such-version"],
    ];
    for (const [bad] of cases) {
      const response = await forest.ownerApi(
        "POST",
        `/ssr/${here}/drafts/approve-matching`,
        { versionIds: [drafts.p1, bad] },
      );
      expect(response.status).toBe(409);
      expect(response.body.versionIds).toEqual([bad]);
    }
    expect(await statuses([drafts.p1, p1.id(1)])).toEqual({
      [drafts.p1]: "draft",
      [p1.id(1)]: "latest",
    });
  });

  it("refuses bearer and x-api-key callers with 403", async () => {
    const { forest, here, drafts } = await setup();
    const body = { versionIds: [drafts.p1] };
    const path = `/ssr/${here}/drafts/approve-matching`;

    const viaKey = await forest.agentApi("POST", path, body);
    expect(viaKey.status).toBe(403);

    const { app } = createApp();
    const viaBearer = await app.request(`/api${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${forest.key}`,
      },
      body: JSON.stringify(body),
    });
    expect(viaBearer.status).toBe(403);

    expect(await statuses([drafts.p1])).toEqual({ [drafts.p1]: "draft" });
  });

  it("rejects more than 200 ids with 400", async () => {
    const { forest, here } = await setup();
    const versionIds = Array.from({ length: 201 }, (_, i) => `v-${i}`);
    const response = await forest.ownerApi(
      "POST",
      `/ssr/${here}/drafts/approve-matching`,
      { versionIds },
    );
    expect(response.status).toBe(400);
  });
});
