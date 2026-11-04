import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  type FakeWorker,
  makeHome,
  type RunningProxy,
  runProxyToExit,
  startProxy,
  startWorker,
  TOKEN_HEADER,
  tokenFile,
  writeToken,
} from "./harness";

const TOKEN = "synthetic-proxy-token-for-tests-only-222222";
const WRONG = "synthetic-proxy-token-for-tests-only-333333";

// OPS-19: the memory proxy on the Mac asks for a token once its file exists.
describe("memory-proxy.mjs token", () => {
  let dir: string;
  let home: string;
  let worker: FakeWorker;
  let proxy: RunningProxy | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tb-memory-proxy-"));
    worker = await startWorker();
    home = makeHome(dir, worker.port);
  });

  afterEach(async () => {
    await proxy?.stop();
    proxy = undefined;
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(
    path: string,
    init: { method?: string; token?: string } = {},
  ): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = {};
    if (init.token !== undefined) headers[TOKEN_HEADER] = init.token;
    const res = await fetch(`http://127.0.0.1:${proxy?.port}${path}`, {
      method: init.method ?? "GET",
      headers,
    });
    return { status: res.status, body: await res.text() };
  }

  it("answers 401 without the header or with a wrong token, 200 with the right one", async () => {
    writeToken(home, TOKEN);
    proxy = await startProxy(home);

    expect(await call("/api/health")).toEqual({ status: 401, body: "" });
    expect(await call("/api/health", { token: WRONG })).toEqual({
      status: 401,
      body: "",
    });
    expect((await call("/api/health", { token: "short" })).status).toBe(401);
    expect(await call("/api/health", { token: TOKEN })).toEqual({
      status: 200,
      body: JSON.stringify({ status: "ok" }),
    });
    // Without the token nothing else is told; with it the old checks still hold.
    expect((await call("/api/observations", { method: "POST" })).status).toBe(
      401,
    );
    expect(
      (await call("/api/observations", { method: "POST", token: TOKEN }))
        .status,
    ).toBe(405);
    expect((await call("/api/settings", { token: TOKEN })).status).toBe(403);

    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]?.[TOKEN_HEADER]).toBeUndefined();
    expect(proxy.output()).toContain("token required");
    expect(proxy.output()).not.toContain(TOKEN);
    expect(proxy.output()).not.toContain(WRONG);
  });

  it("keeps the peer allowlist ahead of the token", async () => {
    writeToken(home, TOKEN);
    proxy = await startProxy(home, { CMEM_PROXY_ALLOW: "10.77.0.1" });

    expect(await call("/api/health", { token: TOKEN })).toEqual({
      status: 403,
      body: "peer not allowed",
    });
    expect(worker.requests).toHaveLength(0);
  });

  it("takes the token file from CMEM_PROXY_TOKEN_FILE", async () => {
    const file = join(dir, "elsewhere");
    writeFileSync(file, TOKEN, { mode: 0o600 });
    proxy = await startProxy(home, { CMEM_PROXY_TOKEN_FILE: file });

    expect((await call("/api/health")).status).toBe(401);
    expect((await call("/api/health", { token: TOKEN })).status).toBe(200);
  });

  it("runs as before without the file and warns once (rollout mode)", async () => {
    proxy = await startProxy(home);

    expect((await call("/api/health")).status).toBe(200);
    expect((await call("/api/health", { token: WRONG })).status).toBe(200);
    expect((await call("/api/observations", { method: "POST" })).status).toBe(
      405,
    );
    const warnings = proxy.output().match(/rollout mode/g) ?? [];
    expect(warnings).toHaveLength(1);
    expect(proxy.output()).toContain(tokenFile(home));
    expect(proxy.output()).toContain("no token");
  });

  it("refuses to start on a token file it cannot use, without printing it", async () => {
    writeToken(home, "too-short-to-be-a-token");

    const { code, output } = await runProxyToExit(home);

    expect(code).toBe(1);
    expect(output).toContain("not starting");
    expect(output).not.toContain("too-short-to-be-a-token");
  });
});
