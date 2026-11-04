import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  type FakeWorker,
  MAC,
  makeHome,
  type RunningProxy,
  scriptEnv,
  startProxy,
  startWorker,
  tokenFile,
  writeToken,
} from "./harness";

const run = promisify(execFile);
const TOKEN = "synthetic-proxy-token-for-tests-only-444444";

async function sh(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run("sh", [join(MAC, script), ...args], {
      env,
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failed.code ?? -1,
      out: (failed.stdout ?? "") + (failed.stderr ?? ""),
    };
  }
}

describe("memory-agent.sh token and check (OPS-19)", () => {
  let dir: string;
  let home: string;
  let worker: FakeWorker;
  let proxy: RunningProxy | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tb-memory-agent-"));
    worker = await startWorker();
    home = makeHome(dir, worker.port);
  });

  afterEach(async () => {
    await proxy?.stop();
    proxy = undefined;
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const agent = (sub: string, port?: number) =>
    sh(
      "memory-agent.sh",
      [sub],
      scriptEnv(home, {
        CMEM_PROXY_LISTEN: "127.0.0.1",
        CMEM_PROXY_PORT: String(port ?? 9),
      }),
    );

  it("makes a 43-character base64url token once, 600 in a 700 directory, and never prints it", async () => {
    const first = await agent("token");
    const file = tokenFile(home);
    const token = readFileSync(file, "utf8");

    expect(first.code).toBe(0);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(first.out).not.toContain(token);

    const again = await agent("token");
    expect(again.code).toBe(0);
    expect(again.out).toContain("уже есть");
    expect(again.out).not.toContain(token);
    expect(readFileSync(file, "utf8")).toBe(token);
  });

  it("check: 401 without the header, 200 with it, POST 405, token not echoed", async () => {
    await agent("token");
    const token = readFileSync(tokenFile(home), "utf8");
    proxy = await startProxy(home);

    const result = await agent("check", proxy.port);

    expect(result.out).toContain("без токена 401");
    expect(result.out).toContain("с токеном 200");
    expect(result.out).toContain("POST 405");
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(token);
    expect(proxy.output()).not.toContain(token);
  });

  it("check fails while the proxy still runs without the token", async () => {
    proxy = await startProxy(home);
    writeToken(home, TOKEN);

    const result = await agent("check", proxy.port);

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("без токена 200");
    expect(result.out).toContain("memory-agent.sh install");
  });

  it("check passes in rollout mode: no token file, proxy without one", async () => {
    proxy = await startProxy(home);

    const result = await agent("check", proxy.port);

    expect(result.code).toBe(0);
    expect(result.out).toContain("режим раскатки");
  });
});

describe("memory-token-push.sh (OPS-19)", () => {
  let dir: string;
  let home: string;
  let bin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-memory-push-"));
    home = join(dir, "home");
    bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    // A stand-in ssh: records its argv and stdin, runs nothing.
    writeFileSync(
      join(bin, "ssh"),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >"${dir}/argv"\ncat >"${dir}/stdin"\n`,
    );
    chmodSync(join(bin, "ssh"), 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const push = (args: string[]) =>
    sh(
      "memory-token-push.sh",
      args,
      scriptEnv(home, { PATH: `${bin}:${process.env.PATH}` }),
    );

  it("sends the token on ssh's stdin only, never in argv or on stdout", async () => {
    writeToken(home, TOKEN);

    const result = await push(["vps.example"]);

    expect(result.code).toBe(0);
    expect(result.out).not.toContain(TOKEN);
    expect(readFileSync(join(dir, "stdin"), "utf8").trim()).toBe(TOKEN);
    const argv = readFileSync(join(dir, "argv"), "utf8");
    expect(argv).not.toContain(TOKEN);
    expect(argv.split("\n")[0]).toBe("root@vps.example");
    expect(argv).toContain("/opt/t-boards/secrets/claude_mem_proxy_token");
    expect(argv).toContain("chown 1001:1001");
    expect(argv).toContain("docker compose -p t-boards up -d app");
  });

  it("stops without a host or without the token file", async () => {
    expect((await push([])).code).toBe(2);
    const missing = await push(["vps.example"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("memory-agent.sh token");
  });
});
