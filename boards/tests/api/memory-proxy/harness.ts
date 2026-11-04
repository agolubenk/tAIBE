import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";

// The Mac memory proxy kit (deploy/vps/mac) against a stand-in claude-mem
// worker on loopback. HOME is always a throwaway directory: nothing here reads
// or writes the real ~/.t-boards-memory or ~/.claude-mem.
export const MAC = resolve(__dirname, "../../../deploy/vps/mac");
export const TOKEN_HEADER = "x-cmem-proxy-token";

export type FakeWorker = {
  port: number;
  /** Every header set the worker received, in order. */
  requests: Record<string, string | string[] | undefined>[];
  close(): Promise<void>;
};

export async function startWorker(): Promise<FakeWorker> {
  const requests: FakeWorker["requests"] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.headers);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

/** A throwaway HOME whose claude-mem settings point at the fake worker. */
export function makeHome(dir: string, workerPort: number): string {
  const home = join(dir, "home");
  mkdirSync(join(home, ".claude-mem"), { recursive: true });
  writeFileSync(
    join(home, ".claude-mem", "settings.json"),
    JSON.stringify({
      CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
      CLAUDE_MEM_WORKER_PORT: String(workerPort),
    }),
  );
  return home;
}

export function tokenFile(home: string): string {
  return join(home, ".t-boards-memory", "proxy_token");
}

export function writeToken(home: string, token: string): void {
  mkdirSync(join(home, ".t-boards-memory"), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile(home), `${token}\n`, { mode: 0o600 });
}

/** Only PATH and HOME from outside, so no stray CMEM_* reaches the scripts. */
export function scriptEnv(
  home: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: home, ...extra };
}

export type RunningProxy = {
  port: number;
  child: ChildProcess;
  /** stdout and stderr together, as launchd writes them into one log. */
  output(): string;
  stop(): Promise<void>;
};

function spawnProxy(home: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [join(MAC, "memory-proxy.mjs")], {
    env: scriptEnv(home, {
      CMEM_PROXY_LISTEN: "127.0.0.1",
      CMEM_PROXY_PORT: "0",
      CMEM_PROXY_ALLOW: "127.0.0.1",
      ...env,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (part: Buffer) => {
    log += part.toString();
  });
  child.stderr?.on("data", (part: Buffer) => {
    log += part.toString();
  });
  return { child, output: () => log };
}

export async function startProxy(
  home: string,
  env: Record<string, string> = {},
): Promise<RunningProxy> {
  const { child, output } = spawnProxy(home, env);
  const port = await new Promise<number>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`proxy did not start: ${output()}`)),
      10_000,
    );
    const onData = () => {
      const match = /127\.0\.0\.1:(\d+) ->/.exec(output());
      if (!match) return;
      clearTimeout(timer);
      done(Number(match[1]));
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`proxy exited with ${code}: ${output()}`));
    });
  });
  return {
    port,
    child,
    output,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

/** Runs the proxy expecting it to refuse to start; resolves with its exit. */
export async function runProxyToExit(
  home: string,
): Promise<{ code: number | null; output: string }> {
  const { child, output } = spawnProxy(home, {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  // close, not exit: it comes after the last of the output.
  const [code] = (await once(child, "close")) as [number | null];
  clearTimeout(timer);
  return { code, output: output() };
}
