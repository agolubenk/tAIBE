import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { ClaudeMemHttpError, createClaudeMemReader } from "./client.js";
import { resolveProxyToken } from "./settings.js";
import type { FetchLike } from "./types.js";

const TOKEN = "synthetic-proxy-token-for-tests-only-000000";

function headerOf(init: RequestInit | undefined): string | undefined {
  return new Headers(init?.headers).get("x-cmem-proxy-token") ?? undefined;
}

// OPS-19: the token file is read on every request, so delivering or removing
// it changes the next request without a restart.
describe("createClaudeMemReader with the proxy token file", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmem-proxy-token-"));
    file = join(dir, "claude_mem_proxy_token");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function reader(fetchImpl: FetchLike) {
    return createClaudeMemReader({
      baseUrl: "http://10.77.0.2:37702",
      fetch: fetchImpl,
      proxyToken: () =>
        resolveProxyToken({ env: { CLAUDE_MEM_PROXY_TOKEN_FILE: file } }),
    });
  }

  it("sends the header on every route while the file exists", async () => {
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    const fetchImpl = vi.fn<FetchLike>(
      async () => new Response("{}", { status: 200 }),
    );
    const client = reader(fetchImpl);

    await client.health().catch(() => undefined);
    await client.listProjects().catch(() => undefined);
    await client.listObservations({ limit: 1 }).catch(() => undefined);
    await client.getObservation(7).catch(() => undefined);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(headerOf(init)).toBe(TOKEN);
      expect(url).not.toContain(TOKEN);
    }
  });

  it("sends no header without the file, and picks up a delivered one", async () => {
    const fetchImpl = vi.fn<FetchLike>(
      async () => new Response("{}", { status: 200 }),
    );
    const client = reader(fetchImpl);

    await client.health().catch(() => undefined);
    writeFileSync(file, TOKEN, { mode: 0o600 });
    await client.health().catch(() => undefined);
    unlinkSync(file);
    await client.health().catch(() => undefined);

    const sent = fetchImpl.mock.calls.map(([, init]) => headerOf(init));
    expect(sent).toEqual([undefined, TOKEN, undefined]);
  });

  it("keeps a refused token out of the error", async () => {
    writeFileSync(file, TOKEN, { mode: 0o600 });
    const client = reader(async () => new Response(null, { status: 401 }));

    const error = await client.health().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClaudeMemHttpError);
    expect((error as ClaudeMemHttpError).status).toBe(401);
    expect(
      JSON.stringify({ ...(error as object), message: String(error) }),
    ).not.toContain(TOKEN);
  });
});
