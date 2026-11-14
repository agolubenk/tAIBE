import { createHash, randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { auth } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

// The shape better-auth issued before TB-136: 64 letters and no prefix.
function keyIssuedBeforePrefix(): string {
  return Array.from(
    { length: 64 },
    () => LETTERS[randomInt(LETTERS.length)],
  ).join("");
}

function listWorkspaces(key: string) {
  const { app } = createApp();
  return app.request("/api/workspace", { headers: { "x-api-key": key } });
}

describe("API integration: the tbk_ prefix of board API keys (TB-136)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("issues a new key as tbk_ and 64 letters, and it works", async () => {
    const { user } = await createWorkspaceMember({ role: "owner" });
    const created = await auth.api.createApiKey({
      body: { userId: user.id, name: "Prefix test" },
    });

    expect(created.key).toMatch(/^tbk_[A-Za-z]{64}$/);
    const [row] = await db
      .select()
      .from(schema.apikeyTable)
      .where(eq(schema.apikeyTable.id, created.id));
    expect(row?.prefix).toBe("tbk_");
    expect(row?.start).toBe(created.key.slice(0, 10));
    expect((await listWorkspaces(created.key)).status).toBe(200);
  });

  it("still accepts a key issued before the prefix", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const key = keyIssuedBeforePrefix();
    await db.insert(schema.apikeyTable).values({
      referenceId: user.id,
      userId: user.id,
      name: "Issued before TB-136",
      // defaultKeyHasher of @better-auth/api-key: sha256, base64url, no padding.
      key: createHash("sha256").update(key).digest("base64url"),
      start: key.slice(0, 6),
      prefix: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      rateLimitEnabled: true,
      rateLimitMax: 100,
      rateLimitTimeWindow: 60_000,
    });

    const response = await listWorkspaces(key);
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { id: string }[]).map(({ id }) => id),
    ).toEqual([workspace.id]);
  });
});
