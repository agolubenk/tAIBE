import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db from "../../apps/api/src/database";
import { ssrConflictTable } from "../../apps/api/src/database/ssr-schema";
import { syncCorpus } from "../../apps/api/src/ssr/sync";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";

// Two workspaces with one owner each: a caller with manage_settings in one
// workspace must not act on, or learn about, the other workspace's SSR rows.
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const commitSha = "6061626364656667686960616263646566676869";

async function addConflict(workspaceId: string) {
  const [conflict] = await db
    .insert(ssrConflictTable)
    .values({
      workspaceId,
      path: ".claude/rules/01-base.md",
      baselineSha: sha256("baseline"),
      repoSha: sha256("repo"),
    })
    .returning();
  if (!conflict) throw new Error("no conflict row");
  return conflict;
}

async function conflictRow(id: string) {
  const [row] = await db
    .select()
    .from(ssrConflictTable)
    .where(eq(ssrConflictTable.id, id));
  return row;
}

async function syncText(workspaceId: string, actor: string, texts: string[]) {
  await syncCorpus(
    workspaceId,
    {
      commitSha,
      files: texts.map((text, index) => ({
        path: `.claude/skills/s${index}-${sha256(text).slice(0, 8)}/NOTE.md`,
        sha256: sha256(text),
        content: text,
      })),
    },
    actor,
  );
}

describe("API integration: SSR workspace scope", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("resolves a conflict of the caller's workspace (owner UI only)", async () => {
    const forest = await createForest();
    const conflict = await addConflict(forest.workspace.id);
    const path = `/ssr/${forest.workspace.id}/conflicts/${conflict.id}/resolve`;

    const viaKey = await forest.agentApi("POST", path);
    expect(viaKey.status).toBe(403);
    expect((await conflictRow(conflict.id))?.status).toBe("open");

    const resolved = await forest.ownerApi("POST", path);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ resolved: true });
    const row = await conflictRow(conflict.id);
    expect(row?.status).toBe("resolved");
    expect(row?.resolvedAt).toBeInstanceOf(Date);
  });

  it("answers 404 for a conflict id of another workspace and changes no row", async () => {
    const here = await createForest();
    const other = await createForest();
    const foreign = await addConflict(other.workspace.id);

    const response = await here.ownerApi(
      "POST",
      `/ssr/${here.workspace.id}/conflicts/${foreign.id}/resolve`,
    );
    expect(response.status).toBe(404);
    expect(response.body.message).toBe("Conflict not found");
    expect(await conflictRow(foreign.id)).toEqual(foreign);

    const unknown = await here.ownerApi(
      "POST",
      `/ssr/${here.workspace.id}/conflicts/no-such-conflict/resolve`,
    );
    expect(unknown.status).toBe(404);
  });

  it("known-shas reports the caller's stored shas and none that only another workspace holds", async () => {
    const here = await createForest();
    const other = await createForest();
    await syncText(here.workspace.id, here.ownerId, ["mine", "shared"]);
    await syncText(other.workspace.id, other.ownerId, ["shared", "theirs"]);
    const shas = ["mine", "shared", "theirs", "never"].map(sha256);

    const mine = await here.ownerApi(
      "POST",
      `/ssr/${here.workspace.id}/known-shas`,
      { shas },
    );
    expect(mine.status).toBe(200);
    expect([...mine.body.shas].sort()).toEqual(
      [sha256("mine"), sha256("shared")].sort(),
    );

    const theirs = await other.ownerApi(
      "POST",
      `/ssr/${other.workspace.id}/known-shas`,
      { shas },
    );
    expect(theirs.status).toBe(200);
    expect([...theirs.body.shas].sort()).toEqual(
      [sha256("shared"), sha256("theirs")].sort(),
    );
  });

  it("sync refuses a file without content whose sha this workspace does not hold", async () => {
    const here = await createForest();
    const other = await createForest();
    await syncText(other.workspace.id, other.ownerId, ["theirs"]);
    const sync = (text: string) =>
      here.ownerApi("POST", `/ssr/${here.workspace.id}/sync`, {
        commitSha,
        files: [{ path: ".claude/skills/probe/NOTE.md", sha256: sha256(text) }],
      });

    // Another workspace's sha and a sha nobody stores answer the same way,
    // so the sync is no oracle and no version can read the other blob.
    for (const text of ["theirs", "never"]) {
      const refused = await sync(text);
      expect(refused.status).toBe(409);
      expect(refused.body.message).toContain(".claude/skills/probe/NOTE.md");
    }
    const entities = await here.ownerApi(
      "GET",
      `/ssr/${here.workspace.id}/entities`,
    );
    expect(entities.body.entities).toEqual([]);
    const known = await here.ownerApi(
      "POST",
      `/ssr/${here.workspace.id}/known-shas`,
      { shas: [sha256("theirs")] },
    );
    expect(known.body.shas).toEqual([]);
  });

  it("known-shas answers an empty list for an empty request", async () => {
    const forest = await createForest();
    const response = await forest.ownerApi(
      "POST",
      `/ssr/${forest.workspace.id}/known-shas`,
      { shas: [] },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ shas: [] });
  });
});
