import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { effectiveNotebookModel } from "../../apps/api/src/notebook-model/effective-notebook-model";
import { mockAuthenticatedSession } from "./helpers/auth";
import { createInstanceAdmin } from "./helpers/admin/create-instance-admin";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";
import { projectAccessApi } from "./helpers/project-access/project-access-api";

// Synthetic values only; none of these is a real key.
const MODEL_KEY = "sk-test-settings-key";
const SETTINGS_KEY = "test-settings-encryption-key-0123456789";

async function storedRow() {
  const [row] = await db
    .select()
    .from(schema.instanceSettingTable)
    .where(eq(schema.instanceSettingTable.key, "notebook.model"));
  return row ?? null;
}

async function asAdmin() {
  mockAuthenticatedSession(await createInstanceAdmin());
  return projectAccessApi();
}

describe("API integration: notebook model settings", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.stubEnv("NOTEBOOK_LLM_MODEL", "");
    vi.stubEnv("NOTEBOOK_LLM_KEY_FILE", "");
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", SETTINGS_KEY);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is limited to instance administrators", async () => {
    const { user } = await createWorkspaceMember("owner");
    mockAuthenticatedSession(user);
    const request = projectAccessApi();

    expect((await request("/admin/notebook-model")).status).toBe(403);
    const put = await request("/admin/notebook-model", {
      method: "PUT",
      body: { model: "x/y" },
    });
    expect(put.status).toBe(403);
    expect(await storedRow()).toBeNull();
  });

  it("stores the key sealed and never returns it", async () => {
    const request = await asAdmin();

    const put = await request("/admin/notebook-model", {
      method: "PUT",
      body: { model: "openai/gpt-4o-mini", dailyMax: 40, key: MODEL_KEY },
    });
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain(MODEL_KEY);
    expect(JSON.parse(text)).toMatchObject({
      model: "openai/gpt-4o-mini",
      dailyMax: 40,
      hasKey: true,
      keySource: "settings",
      keyUnreadable: false,
      canStoreKey: true,
    });

    const row = await storedRow();
    expect(row?.value).toContain("enc:v1:");
    expect(row?.value).not.toContain(MODEL_KEY);
    expect(row?.updatedBy).toMatch(/^admin-/);
  });

  it("keeps fields left out and clears fields set to null", async () => {
    const request = await asAdmin();
    await request("/admin/notebook-model", {
      method: "PUT",
      body: { model: "a/b", embedModel: "bge-m3", key: MODEL_KEY },
    });

    const kept = await request("/admin/notebook-model", {
      method: "PUT",
      body: { dailyMax: 7 },
    });
    expect(await kept.json()).toMatchObject({
      model: "a/b",
      embedModel: "bge-m3",
      dailyMax: 7,
      keySource: "settings",
    });

    const cleared = await request("/admin/notebook-model", {
      method: "PUT",
      body: { model: null, key: null },
    });
    expect(await cleared.json()).toMatchObject({
      model: null,
      embedModel: "bge-m3",
      hasKey: false,
      keySource: null,
    });
  });

  it("refuses a key while the server has no settings encryption key", async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY_FILE", "/nonexistent/settings_key");
    const request = await asAdmin();

    const view = await request("/admin/notebook-model");
    expect(await view.json()).toMatchObject({ canStoreKey: false });

    const put = await request("/admin/notebook-model", {
      method: "PUT",
      body: { key: MODEL_KEY },
    });
    expect(put.status).toBe(409);
    expect(await storedRow()).toBeNull();
  });

  it("reports a stored key the server can no longer open", async () => {
    const request = await asAdmin();
    await request("/admin/notebook-model", {
      method: "PUT",
      body: { key: MODEL_KEY },
    });

    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "another-settings-key-0123456789abc");
    const view = await request("/admin/notebook-model");
    expect(await view.json()).toMatchObject({
      hasKey: false,
      keySource: null,
      keyUnreadable: true,
    });
  });

  it("rejects a malformed address and an out-of-range limit", async () => {
    const request = await asAdmin();
    for (const body of [
      { baseUrl: "not a url" },
      { baseUrl: "http://gw.example/v1" },
      { dailyMax: -1 },
    ]) {
      const put = await request("/admin/notebook-model", {
        method: "PUT",
        body,
      });
      expect(put.status).toBe(400);
    }
    expect(await storedRow()).toBeNull();
  });

  it("binds a stored key to its API address", async () => {
    const request = await asAdmin();
    const put = (body: Record<string, unknown>) =>
      request("/admin/notebook-model", { method: "PUT", body });

    const saved = await put({
      baseUrl: "https://gw.example/v1/",
      key: MODEL_KEY,
    });
    expect(await saved.json()).toMatchObject({
      baseUrl: "https://gw.example/v1",
      keySource: "settings",
    });

    // Another host would receive the key: it has to be entered again.
    const moved = await put({ baseUrl: "https://collector.example/v1" });
    expect(moved.status).toBe(409);
    const back = await put({ baseUrl: null });
    expect(back.status).toBe(409);
    expect(await storedRow()).toMatchObject({
      value: expect.stringContaining("https://gw.example/v1"),
    });

    const samehost = await put({ baseUrl: "https://gw.example/v2" });
    expect(await samehost.json()).toMatchObject({ keySource: "settings" });

    const rekeyed = await put({
      baseUrl: "https://collector.example/v1",
      key: MODEL_KEY,
    });
    expect(await rekeyed.json()).toMatchObject({
      baseUrl: "https://collector.example/v1",
      keySource: "settings",
    });
  });

  it("keeps the server's key file to the server's own address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notebook-model-"));
    try {
      writeFileSync(join(dir, "key"), "sk-test-file-key\n");
      vi.stubEnv("NOTEBOOK_LLM_KEY_FILE", join(dir, "key"));
      const request = await asAdmin();

      const before = await request("/admin/notebook-model");
      expect(await before.json()).toMatchObject({
        keySource: "file",
        fileKeyWithheld: false,
      });

      const moved = await request("/admin/notebook-model", {
        method: "PUT",
        body: { baseUrl: "https://collector.example/v1" },
      });
      expect(await moved.json()).toMatchObject({
        hasKey: false,
        keySource: null,
        fileKeyWithheld: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends the thinking switch only to the server's own address", async () => {
    vi.stubEnv("NOTEBOOK_LLM_BASE_URL", "https://api.z.ai/api/coding/paas/v4");
    vi.stubEnv("NOTEBOOK_LLM_THINKING", " disabled ");
    const request = await asAdmin();
    expect(await effectiveNotebookModel()).toMatchObject({
      thinking: "disabled",
    });

    await request("/admin/notebook-model", {
      method: "PUT",
      body: { baseUrl: "https://collector.example/v1" },
    });
    expect(await effectiveNotebookModel()).toMatchObject({ thinking: null });

    await request("/admin/notebook-model", {
      method: "PUT",
      body: { baseUrl: null },
    });
    expect(await effectiveNotebookModel()).toMatchObject({
      thinking: "disabled",
    });
  });

  it("keeps the stored key when another field is broken", async () => {
    const request = await asAdmin();
    await request("/admin/notebook-model", {
      method: "PUT",
      body: { model: "a/b", key: MODEL_KEY },
    });
    const row = await storedRow();
    const value = { ...JSON.parse(String(row?.value)), dailyMax: "many" };
    await db
      .update(schema.instanceSettingTable)
      .set({ value: JSON.stringify(value) })
      .where(eq(schema.instanceSettingTable.key, "notebook.model"));

    const view = await request("/admin/notebook-model");
    expect(await view.json()).toMatchObject({
      model: "a/b",
      dailyMax: 500,
      keySource: "settings",
    });
  });

  it("keeps every field of saves made at the same time", async () => {
    const request = await asAdmin();
    const saves = await Promise.all(
      [{ model: "a/b" }, { dailyMax: 3 }, { embedModel: "bge-m3" }].map(
        (body) => request("/admin/notebook-model", { method: "PUT", body }),
      ),
    );
    expect(saves.map((save) => save.status)).toEqual([200, 200, 200]);

    const view = await request("/admin/notebook-model");
    expect(await view.json()).toMatchObject({
      model: "a/b",
      dailyMax: 3,
      embedModel: "bge-m3",
    });
  });

  describe("model chain (TB-159)", () => {
    const CHAIN_KEY = "sk-test-chain-key";
    const put = async (body: Record<string, unknown>) =>
      (await asAdmin())("/admin/notebook-model", { method: "PUT", body });

    it("stores the chain in the admin's order with write-only keys", async () => {
      const saved = await put({
        model: "a/main",
        key: MODEL_KEY,
        chain: [
          {
            baseUrl: "https://openrouter.ai/api/v1/",
            model: "x/free:free",
            models: ["y/free:free"],
            key: CHAIN_KEY,
          },
          { baseUrl: "https://glm.example/v4", model: "glm-4.6" },
        ],
      });
      expect(saved.status).toBe(200);
      const text = await saved.text();
      expect(text).not.toContain(CHAIN_KEY);
      const view = JSON.parse(text);
      expect(view).toMatchObject({
        models: [],
        pointCallsToday: 0,
        failsSinceStart: 0,
        chain: [
          {
            baseUrl: "https://openrouter.ai/api/v1",
            model: "x/free:free",
            models: ["y/free:free"],
            hasKey: true,
            keySource: "settings",
            callsToday: 0,
            failsSinceStart: 0,
          },
          {
            baseUrl: "https://glm.example/v4",
            model: "glm-4.6",
            models: [],
            hasKey: false,
            keySource: null,
          },
        ],
      });
      expect(view.chain[0].id).not.toBe(view.chain[1].id);

      const row = await storedRow();
      expect(row?.value).not.toContain(CHAIN_KEY);
      expect(JSON.parse(String(row?.value)).chain[0].key).toMatch(/^enc:v1:/);
    });

    it("keeps a point's key by its id on the same address only", async () => {
      const first = await put({
        chain: [
          { baseUrl: "https://gw.example/v1", model: "m1", key: CHAIN_KEY },
        ],
      });
      const [{ id }] = (await first.json()).chain;

      const renamed = await put({
        chain: [{ id, baseUrl: "https://gw.example/v2", model: "m2" }],
      });
      expect((await renamed.json()).chain).toMatchObject([
        { id, model: "m2", keySource: "settings" },
      ]);

      const kept = await put({ dailyMax: 9 });
      expect((await kept.json()).chain).toMatchObject([{ id, hasKey: true }]);

      const moved = await put({
        chain: [{ id, baseUrl: "https://collector.example/v1", model: "m2" }],
      });
      expect(moved.status).toBe(409);
      expect((await storedRow())?.value).toContain("https://gw.example/v2");

      const added = await put({
        chain: [{ baseUrl: "https://collector.example/v1", model: "m2" }],
      });
      expect((await added.json()).chain).toMatchObject([
        { hasKey: false, model: "m2" },
      ]);
    });

    it("refuses an id that is not in the chain or is sent twice", async () => {
      const first = await put({
        chain: [
          { baseUrl: "https://gw.example/v1", model: "m1", key: CHAIN_KEY },
        ],
      });
      const [{ id }] = (await first.json()).chain;
      const point = { id, baseUrl: "https://gw.example/v1", model: "m1" };

      expect(
        (await put({ chain: [{ ...point, id: "not-there" }] })).status,
      ).toBe(400);
      expect((await put({ chain: [point, point] })).status).toBe(400);
      expect((await storedRow())?.value).toContain(id);
    });

    it("removes a point's key with null and the chain with null", async () => {
      const first = await put({
        chain: [
          { baseUrl: "https://gw.example/v1", model: "m1", key: CHAIN_KEY },
        ],
      });
      const [{ id }] = (await first.json()).chain;

      const keyless = await put({
        chain: [
          { id, baseUrl: "https://gw.example/v1", model: "m1", key: null },
        ],
      });
      expect((await keyless.json()).chain).toMatchObject([
        { id, hasKey: false },
      ]);

      const cleared = await put({ chain: null });
      expect((await cleared.json()).chain).toEqual([]);
      expect(JSON.parse(String((await storedRow())?.value))).not.toHaveProperty(
        "chain",
      );
    });

    it("refuses a chain key while the server has no settings encryption key", async () => {
      vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "");
      vi.stubEnv("SETTINGS_ENCRYPTION_KEY_FILE", "/nonexistent/settings_key");
      const refused = await put({
        chain: [
          { baseUrl: "https://gw.example/v1", model: "m1", key: CHAIN_KEY },
        ],
      });
      expect(refused.status).toBe(409);
      expect(await storedRow()).toBeNull();
    });

    it("rejects an http point, too many points and too many fallbacks", async () => {
      const point = { baseUrl: "https://gw.example/v1", model: "m1" };
      for (const chain of [
        [{ ...point, baseUrl: "http://gw.example/v1" }],
        Array.from({ length: 5 }, () => point),
        [{ ...point, models: ["a", "b", "c", "d"] }],
        [{ baseUrl: point.baseUrl }],
      ]) {
        expect((await put({ chain })).status).toBe(400);
      }
      expect(await storedRow()).toBeNull();
    });

    it("gives a point at the server's address the key file and thinking, and withholds them elsewhere", async () => {
      const dir = mkdtempSync(join(tmpdir(), "notebook-model-"));
      try {
        writeFileSync(join(dir, "key"), "sk-test-file-key\n");
        vi.stubEnv(
          "NOTEBOOK_LLM_BASE_URL",
          "https://api.z.ai/api/coding/paas/v4",
        );
        vi.stubEnv("NOTEBOOK_LLM_KEY_FILE", join(dir, "key"));
        vi.stubEnv("NOTEBOOK_LLM_THINKING", "disabled");
        const saved = await put({
          baseUrl: "https://openrouter.ai/api/v1",
          model: "x/free:free",
          key: MODEL_KEY,
          chain: [
            {
              baseUrl: "https://api.z.ai/api/coding/paas/v4",
              model: "glm-4.6",
            },
            { baseUrl: "https://other.example/v1", model: "o1" },
          ],
        });
        expect((await saved.json()).chain).toMatchObject([
          { hasKey: true, keySource: "file", fileKeyWithheld: false },
          { hasKey: false, keySource: null, fileKeyWithheld: true },
        ]);
        const settings = await effectiveNotebookModel();
        expect(settings.thinking).toBeNull();
        expect(settings.chain.map((point) => point.thinking)).toEqual([
          "disabled",
          null,
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("drops a broken chain point and keeps the others", async () => {
      await put({
        chain: [
          { baseUrl: "https://gw.example/v1", model: "m1", key: CHAIN_KEY },
        ],
      });
      const row = await storedRow();
      const value = JSON.parse(String(row?.value));
      value.chain.push({
        id: "broken",
        baseUrl: "http://gw.example",
        model: "",
      });
      await db
        .update(schema.instanceSettingTable)
        .set({ value: JSON.stringify(value) })
        .where(eq(schema.instanceSettingTable.key, "notebook.model"));

      const view = await (await asAdmin())("/admin/notebook-model");
      expect((await view.json()).chain).toMatchObject([
        { model: "m1", keySource: "settings" },
      ]);
    });
  });
});
