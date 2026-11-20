import { once } from "node:events";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { getMemoryReader, memoryRoots } from "./memory-reader";

const TOKEN = "synthetic-proxy-token-for-tests-only-111111";
const KEYS = [
  "CLAUDE_MEM_WORKER_HOST",
  "CLAUDE_MEM_WORKER_PORT",
  "CLAUDE_MEM_PROXY_TOKEN_FILE",
] as const;

// The app's reader against a stand-in for the Mac proxy (OPS-19): the header
// goes on the wire while the compose secret file exists, and only then.
describe("getMemoryReader and the proxy token", () => {
  const seen: (string | undefined)[] = [];
  const saved = new Map<string, string | undefined>();
  let worker: Server;
  let dir: string;
  let file: string;

  beforeAll(async () => {
    worker = createServer((req, res) => {
      const header = req.headers["x-cmem-proxy-token"];
      seen.push(typeof header === "string" ? header : undefined);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
    });
    worker.listen(0, "127.0.0.1");
    await once(worker, "listening");
    dir = mkdtempSync(join(tmpdir(), "tb-memory-reader-"));
    file = join(dir, "claude_mem_proxy_token");
    for (const key of KEYS) saved.set(key, process.env[key]);
    process.env.CLAUDE_MEM_WORKER_HOST = "127.0.0.1";
    process.env.CLAUDE_MEM_WORKER_PORT = String(
      (worker.address() as AddressInfo).port,
    );
    process.env.CLAUDE_MEM_PROXY_TOKEN_FILE = file;
  });

  afterAll(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    await new Promise((done) => worker.close(done));
  });

  it("sends x-cmem-proxy-token from the file, and nothing once it is gone", async () => {
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    const fresh = await getMemoryReader().health();
    unlinkSync(file);
    await getMemoryReader().health();

    expect(fresh.stale).toBe(false);
    expect(seen).toEqual([TOKEN, undefined]);
  });
});

// TB-58 (R-002): the claude-mem project roots of one workspace.
describe("memoryRoots", () => {
  const env = (value: string) => ({ CLAUDE_MEM_PROJECTS: value });

  it("reads the roots of the workspace from the pair list", () => {
    const map = env(" ws1 = tAIBE | tAIBE-lab , ws2=HR_Helper-v2,ws3=terminal");
    expect(memoryRoots("ws1", map)).toEqual(["tAIBE", "tAIBE-lab"]);
    expect(memoryRoots("ws2", map)).toEqual(["HR_Helper-v2"]);
  });

  it("gives no roots to a workspace that is not on the list (fail closed)", () => {
    expect(memoryRoots("ws9", env("ws1=tAIBE"))).toEqual([]);
    expect(memoryRoots("ws1", {})).toEqual([]);
    expect(memoryRoots("ws1", env("ws1="))).toEqual([]);
    expect(memoryRoots("ws1", env("=tAIBE"))).toEqual([]);
  });

  it("drops a root outside the proxy's form and keeps at most 4", () => {
    expect(memoryRoots("ws1", env("ws1=a/b|t AIBE||tAIBE|tAIBE"))).toEqual([
      "tAIBE",
    ]);
    expect(memoryRoots("ws1", env("ws1=a|b|c|d|e"))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});
