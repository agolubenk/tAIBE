import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  ssrEntityTable,
  ssrVersionTable,
} from "../../apps/api/src/database/ssr-schema";
import { createApp } from "../../apps/api/src/index";
import { approveDraft } from "../../apps/api/src/ssr/approve";
import { syncCorpus } from "../../apps/api/src/ssr/sync";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";
import { createForest } from "./helpers/forest";

// Approve-matching (owner action): a draft is approved in bulk only when the
// server proves the caller already approved the same path + blob sha in a
// workspace they can read. A workspace they cannot read never vouches and is
// never revealed.
const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const OWNER_ONLY =
  "Owner decisions are made from the owner's browser session only";

type SeedVersion = {
  number: number;
  text: string;
  status: "latest" | "superseded" | "draft" | "rejected";
  origin?: "sync" | "owner" | "rollback";
  approvedBy?: string;
};

async function seedEntity(
  workspaceId: string,
  path: string,
  versions: SeedVersion[],
  status: "active" | "archived" = "active",
) {
  const [entity] = await db
    .insert(ssrEntityTable)
    .values({ workspaceId, kind: "skill", name: path, path, status })
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
        approvedAt: version.approvedBy ? new Date() : null,
        approvedBy: version.approvedBy ?? null,
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

async function addSourceWorkspace(ownerId: string) {
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
    userId: ownerId,
    role: "owner",
    joinedAt: new Date(),
  });
  return source;
}

async function setup() {
  const forest = await createForest();
  const here = forest.workspace.id;
  const mine = forest.ownerId;
  const source = await addSourceWorkspace(mine);
  // Somebody else's workspace: the owner is not a member and cannot read it.
  const { workspace: foreign } = await createWorkspaceMember({
    workspaceName: "Hidden workspace",
    role: "owner",
  });
  const draft = (text: string): SeedVersion[] => [
    { number: 1, text, status: "draft", origin: "sync" },
  ];

  const here1 = await seedEntity(here, "skills/p1", [
    { number: 1, text: "old", status: "latest", approvedBy: mine },
    { number: 2, text: "one", status: "draft", origin: "sync" },
  ]);
  const drafts = {
    p1: here1.id(2),
    p2: (await seedEntity(here, "skills/p2", draft("two"))).id(1),
    p3: (await seedEntity(here, "skills/p3", draft("three"))).id(1),
    p4: (await seedEntity(here, "skills/p4", draft("four"))).id(1),
    p6: (await seedEntity(here, "skills/p6", draft("six"))).id(1),
    p7: (await seedEntity(here, "skills/p7", draft("seven"))).id(1),
    p8: (await seedEntity(here, "skills/p8", draft("eight"))).id(1),
    p9: (await seedEntity(here, "skills/p9", draft("nine"))).id(1),
    // The entity already rejected these exact bytes.
    p10: (
      await seedEntity(here, "skills/p10", [
        { number: 1, text: "ten", status: "rejected", approvedBy: mine },
        { number: 2, text: "ten", status: "draft", origin: "sync" },
      ])
    ).id(2),
    p11: (await seedEntity(here, "skills/p11", draft("eleven"), "archived")).id(
      1,
    ),
    // A draft below a newer version.
    p12: (
      await seedEntity(here, "skills/p12", [
        { number: 1, text: "twelve", status: "draft", origin: "sync" },
        { number: 2, text: "other", status: "rejected", approvedBy: mine },
      ])
    ).id(1),
    // The owner approved these bytes before in this very workspace.
    p13: (
      await seedEntity(here, "skills/p13", [
        { number: 1, text: "thirteen", status: "superseded", approvedBy: mine },
        { number: 2, text: "thirteen-b", status: "latest", approvedBy: mine },
        { number: 3, text: "thirteen", status: "draft", origin: "sync" },
      ])
    ).id(3),
  };

  await seedEntity(source.id, "skills/p1", [
    { number: 1, text: "zero", status: "superseded", approvedBy: mine },
    { number: 2, text: "one", status: "latest", approvedBy: mine },
  ]);
  // A superseded version the owner approved still vouches.
  await seedEntity(source.id, "skills/p2", [
    { number: 1, text: "two", status: "superseded", approvedBy: mine },
    { number: 2, text: "two-b", status: "latest", approvedBy: mine },
  ]);
  // Drafts and rejected versions never vouch.
  await seedEntity(source.id, "skills/p3", [
    { number: 1, text: "three", status: "rejected", approvedBy: mine },
    { number: 2, text: "three", status: "draft", origin: "sync" },
  ]);
  // Same path with other bytes, same bytes at another path.
  await seedEntity(source.id, "skills/p4", [
    { number: 1, text: "four-b", status: "latest", approvedBy: mine },
  ]);
  await seedEntity(source.id, "skills/p5", [
    { number: 1, text: "four", status: "latest", approvedBy: mine },
  ]);
  // Only the unreadable workspace holds p6's bytes.
  await seedEntity(foreign.id, "skills/p6", [
    { number: 1, text: "six", status: "latest", approvedBy: mine },
  ]);
  // Approved by another user.
  await seedEntity(source.id, "skills/p7", [
    { number: 1, text: "seven", status: "latest", approvedBy: "user-other" },
  ]);
  // A sync auto-bump, never approved by the owner.
  await seedEntity(source.id, "skills/p8", [
    { number: 1, text: "eight", status: "superseded", origin: "sync" },
    { number: 2, text: "eight-b", status: "latest", origin: "sync" },
  ]);
  // The owner rolled away from these bytes.
  await seedEntity(source.id, "skills/p9", [
    { number: 1, text: "nine-a", status: "superseded", approvedBy: mine },
    { number: 2, text: "nine", status: "superseded", approvedBy: mine },
    {
      number: 3,
      text: "nine-a",
      status: "latest",
      origin: "rollback",
      approvedBy: mine,
    },
  ]);
  for (const [path, text] of [
    ["skills/p10", "ten"],
    ["skills/p11", "eleven"],
    ["skills/p12", "twelve"],
  ] as const) {
    await seedEntity(source.id, path, [
      { number: 1, text, status: "latest", approvedBy: mine },
    ]);
  }

  const texts: Record<keyof typeof drafts, string> = {
    p1: "one",
    p2: "two",
    p3: "three",
    p4: "four",
    p6: "six",
    p7: "seven",
    p8: "eight",
    p9: "nine",
    p10: "ten",
    p11: "eleven",
    p12: "twelve",
    p13: "thirteen",
  };
  const item = (key: keyof typeof drafts) => ({
    versionId: drafts[key],
    blobSha: sha(texts[key]),
  });
  const matches = async () => {
    const response = await forest.ownerApi(
      "GET",
      `/ssr/${here}/drafts/matches`,
    );
    expect(response.status).toBe(200);
    return new Map<string, { match: unknown; blobSha: string }>(
      response.body.drafts.map(
        (row: { versionId: string; match: unknown; blobSha: string }) => [
          row.versionId,
          row,
        ],
      ),
    );
  };
  const approve = (items: unknown[]) =>
    forest.ownerApi("POST", `/ssr/${here}/drafts/approve-matching`, {
      items,
    });
  return {
    forest,
    here,
    source,
    foreign,
    drafts,
    here1,
    item,
    matches,
    approve,
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

  it("lists only same-path, same-sha twins the owner approved in readable workspaces", async () => {
    const { source, foreign, drafts, matches, forest, here } = await setup();
    const byVersion = await matches();
    expect(byVersion.size).toBe(Object.keys(drafts).length);
    expect(byVersion.get(drafts.p1)?.match).toEqual(
      expect.objectContaining({
        workspaceId: source.id,
        workspaceName: "aiBoards&eval",
        number: 2,
      }),
    );
    expect(byVersion.get(drafts.p1)?.blobSha).toBe(sha("one"));
    expect(byVersion.get(drafts.p2)?.match).toEqual(
      expect.objectContaining({ workspaceId: source.id, number: 1 }),
    );
    expect(byVersion.get(drafts.p3)?.match).toBeNull();
    expect(byVersion.get(drafts.p4)?.match).toBeNull();
    // No leak: the unreadable workspace neither matches nor shows up.
    expect(byVersion.get(drafts.p6)?.match).toBeNull();
    const raw = await forest.ownerApi("GET", `/ssr/${here}/drafts/matches`);
    const text = JSON.stringify(raw.body);
    expect(text).not.toContain(foreign.id);
    expect(text).not.toContain("Hidden workspace");
  });

  it.each([
    ["approved by another user", "p7"],
    ["a sync auto-bump", "p8"],
    ["rolled away from by a later rollback", "p9"],
  ] as const)("a twin %s does not vouch", async (_label, key) => {
    const { drafts, matches, approve, item } = await setup();
    expect((await matches()).get(drafts[key])?.match).toBeNull();
    const response = await approve([item(key)]);
    expect(response.status).toBe(409);
    expect(response.body.versionIds).toEqual([drafts[key]]);
    expect(await statuses([drafts[key]])).toEqual({ [drafts[key]]: "draft" });
  });

  it.each([
    ["bytes its entity already rejected", "p10"],
    ["an archived entity", "p11"],
    ["a draft below a newer version", "p12"],
  ] as const)("excludes %s", async (_label, key) => {
    const { drafts, matches, approve, item } = await setup();
    expect((await matches()).get(drafts[key])?.match).toBeNull();
    const response = await approve([item(key)]);
    expect(response.status).toBe(409);
    expect(await statuses([drafts[key]])).toEqual({ [drafts[key]]: "draft" });
  });

  it("approves every listed draft in one transaction and records the twin", async () => {
    const { forest, drafts, here1, item, approve, matches } = await setup();
    const response = await approve([item("p1"), item("p2"), item("p13")]);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      approved: 3,
      versionIds: [drafts.p1, drafts.p2, drafts.p13],
    });

    expect(await statuses([here1.id(1), drafts.p1, drafts.p2])).toEqual({
      [here1.id(1)]: "superseded",
      [drafts.p1]: "latest",
      [drafts.p2]: "latest",
    });
    const approved = await db
      .select()
      .from(ssrVersionTable)
      .where(inArray(ssrVersionTable.id, [drafts.p1, drafts.p2, drafts.p13]))
      .orderBy(ssrVersionTable.blobSha);
    const byId = new Map(approved.map((row) => [row.id, row]));
    expect(byId.get(drafts.p1)?.approvedBy).toBe(forest.ownerId);
    expect(byId.get(drafts.p1)?.approvedAt).toBeInstanceOf(Date);
    // A twin elsewhere is named neither by workspace nor by number (R-002):
    // every reader of this workspace, a scoped key included, sees the message.
    const elsewhere =
      "Approved as byte-identical to a version you approved earlier";
    expect(byId.get(drafts.p1)?.message).toBe(elsewhere);
    expect(byId.get(drafts.p2)?.message).toBe(elsewhere);
    expect(byId.get(drafts.p13)?.message).toBe(
      "Approved as byte-identical to v1",
    );
    for (const row of approved) {
      expect(row.message).not.toContain("aiBoards&eval");
    }
    const [entity] = await db
      .select()
      .from(ssrEntityTable)
      .where(eq(ssrEntityTable.id, here1.entityId));
    expect(entity?.latestVersionId).toBe(drafts.p1);
    expect(entity?.status).toBe("active");

    // The approved drafts are no longer open: the list shrinks to the rest.
    expect((await matches()).size).toBe(Object.keys(drafts).length - 3);
  });

  it("refuses the whole batch with 409 when any item does not match", async () => {
    const { drafts, here1, item, approve } = await setup();
    const cases = [
      item("p3"), // no approved twin
      { versionId: here1.id(1), blobSha: sha("old") }, // not a draft
      item("p6"), // twin only in an unreadable workspace
      { versionId: "no-such-version", blobSha: sha("x") },
    ];
    for (const bad of cases) {
      const response = await approve([item("p1"), bad]);
      expect(response.status).toBe(409);
      expect(response.body.versionIds).toEqual([bad.versionId]);
    }
    expect(await statuses([drafts.p1, here1.id(1)])).toEqual({
      [drafts.p1]: "draft",
      [here1.id(1)]: "latest",
    });
  });

  it("refuses with 409 when the draft bytes differ from the ones the owner saw", async () => {
    const { drafts, item, approve } = await setup();
    const response = await approve([
      item("p2"),
      { versionId: drafts.p1, blobSha: sha("bytes the owner never saw") },
    ]);
    expect(response.status).toBe(409);
    expect(response.body.versionIds).toEqual([drafts.p1]);
    expect(await statuses([drafts.p1, drafts.p2])).toEqual({
      [drafts.p1]: "draft",
      [drafts.p2]: "draft",
    });
  });

  it("refuses bearer and x-api-key callers with 403, with or without a session cookie", async () => {
    const { forest, here, drafts, item } = await setup();
    const body = { items: [item("p1")] };
    const path = `/ssr/${here}/drafts/approve-matching`;

    const viaKey = await forest.agentApi("POST", path, body);
    expect(viaKey.status).toBe(403);
    expect(viaKey.body.message).toBe(OWNER_ONLY);

    const { app } = createApp();
    const send = (headers: Record<string, string>) =>
      app.request(`/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const viaBearer = await send({ authorization: `Bearer ${forest.key}` });
    expect(viaBearer.status).toBe(403);

    // The owner's own browser session plus a token is still not the owner UI.
    const [owner] = await db
      .select()
      .from(schema.userTable)
      .where(eq(schema.userTable.id, forest.ownerId));
    if (!owner) throw new Error("no owner row");
    mockAuthenticatedSession(owner);
    const cookie = "better-auth.session_token=owner-session";
    for (const headers of [
      { cookie, authorization: `Bearer ${forest.key}` },
      { cookie, "x-api-key": forest.key },
    ]) {
      const response = await send(headers);
      expect(response.status).toBe(403);
      expect((await response.json()).message).toBe(OWNER_ONLY);
    }

    expect(await statuses([drafts.p1])).toEqual({ [drafts.p1]: "draft" });
  });

  it("bounds the input: 400 above 200 items or on a malformed item, 413 above 32 KB", async () => {
    const { forest, here, approve } = await setup();
    const many = Array.from({ length: 201 }, (_, i) => ({
      versionId: `v-${i}`,
      blobSha: sha(String(i)),
    }));
    expect((await approve(many)).status).toBe(400);
    expect(
      (await approve([{ versionId: "x".repeat(65), blobSha: sha("x") }]))
        .status,
    ).toBe(400);
    expect((await approve([{ versionId: "v-1", blobSha: "abc" }])).status).toBe(
      400,
    );
    expect((await approve([])).status).toBe(400);
    const huge = await forest.ownerApi(
      "POST",
      `/ssr/${here}/drafts/approve-matching`,
      { items: [], pad: "x".repeat(33 * 1024) },
    );
    expect(huge.status).toBe(413);
  });

  it("matches a multi-file skill synced into both workspaces by its aggregate sha", async () => {
    const forest = await createForest();
    const here = forest.workspace.id;
    const source = await addSourceWorkspace(forest.ownerId);
    const files = (variant: string) => [
      { path: ".claude/skills/multi/SKILL.md", text: "# Multi" },
      { path: ".claude/skills/multi/ref.md", text: `ref ${variant}` },
      { path: ".claude/skills/solo/SKILL.md", text: "# Solo" },
      { path: ".claude/skills/solo/notes.md", text: `notes ${variant}` },
    ];
    const manifest = (list: ReturnType<typeof files>) =>
      list.map((file) => ({
        path: file.path,
        sha256: sha(file.text),
        content: file.text,
      }));
    const commitSha = "6061626364656667686960616263646566676869";

    // Source: both skills synced and approved by the owner.
    const synced = await syncCorpus(
      source.id,
      { commitSha, files: manifest(files("a")) },
      forest.ownerId,
    );
    for (const created of synced.created) {
      const [version] = await db
        .select()
        .from(ssrVersionTable)
        .where(eq(ssrVersionTable.id, created.versionId));
      if (!version) throw new Error("no synced version");
      await approveDraft(
        source.id,
        version.entityId,
        version.id,
        forest.ownerId,
      );
    }

    // Here: "multi" has the same two files; "solo" differs in one file.
    const here1 = files("a").slice(0, 2).concat(files("b").slice(2));
    const sync = await forest.ownerApi("POST", `/ssr/${here}/sync`, {
      commitSha,
      files: manifest(here1),
    });
    expect(sync.status).toBe(200);
    const listed = await forest.ownerApi("GET", `/ssr/${here}/drafts/matches`);
    const byPath = new Map<
      string,
      { versionId: string; blobSha: string; match: { number: number } | null }
    >(
      listed.body.drafts.map(
        (row: {
          path: string;
          versionId: string;
          blobSha: string;
          match: { number: number } | null;
        }) => [row.path, row],
      ),
    );
    const multi = byPath.get(".claude/skills/multi");
    const solo = byPath.get(".claude/skills/solo");
    expect(multi?.match).toEqual(
      expect.objectContaining({ workspaceName: "aiBoards&eval", number: 1 }),
    );
    expect(solo?.match).toBeNull();
    if (!multi) throw new Error("multi draft missing");

    const approved = await forest.ownerApi(
      "POST",
      `/ssr/${here}/drafts/approve-matching`,
      { items: [{ versionId: multi.versionId, blobSha: multi.blobSha }] },
    );
    expect(approved.status).toBe(200);
    const [version] = await db
      .select()
      .from(ssrVersionTable)
      .where(eq(ssrVersionTable.id, multi.versionId));
    expect(version?.status).toBe("latest");
    expect(version?.files).toHaveLength(2);
    expect(version?.message).toBe(
      "Approved as byte-identical to a version you approved earlier",
    );
  });

  it("answers an empty list without looking further when nothing waits", async () => {
    const forest = await createForest();
    const response = await forest.ownerApi(
      "GET",
      `/ssr/${forest.workspace.id}/drafts/matches`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ drafts: [] });
  });
});
