import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_WORKER_HOST,
  DEFAULT_WORKER_PORT,
  resolveProxyToken,
  resolveWorkerUrl,
} from "./settings.js";

const noFile = () => undefined;

describe("resolveWorkerUrl", () => {
  it("prefers CLAUDE_MEM_WORKER_PORT from env over settings", () => {
    const url = resolveWorkerUrl({
      env: { CLAUDE_MEM_WORKER_PORT: "41000" },
      readFile: () => JSON.stringify({ CLAUDE_MEM_WORKER_PORT: "37701" }),
    });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:41000`);
  });

  it("reads the port from settings.json when env is missing", () => {
    const url = resolveWorkerUrl({
      env: {},
      readFile: () =>
        JSON.stringify({
          CLAUDE_MEM_WORKER_PORT: "37701",
          CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
        }),
    });
    expect(url).toBe("http://127.0.0.1:37701");
  });

  it("falls back to defaults when neither env nor settings exist", () => {
    const url = resolveWorkerUrl({ env: {}, readFile: noFile });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:${DEFAULT_WORKER_PORT}`);
  });

  it("honours a custom settingsPath", () => {
    const seen: string[] = [];
    resolveWorkerUrl({
      env: {},
      settingsPath: "/tmp/synthetic/settings.json",
      readFile: (path) => {
        seen.push(path);
        return undefined;
      },
    });
    expect(seen).toEqual(["/tmp/synthetic/settings.json"]);
  });

  it("treats invalid JSON in settings as absent", () => {
    const url = resolveWorkerUrl({
      env: {},
      readFile: () => "{ not json",
    });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:${DEFAULT_WORKER_PORT}`);
  });

  it("ignores a non-numeric port", () => {
    const url = resolveWorkerUrl({
      env: { CLAUDE_MEM_WORKER_PORT: "abc" },
      readFile: noFile,
    });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:${DEFAULT_WORKER_PORT}`);
  });

  it("ignores out-of-range ports", () => {
    const url = resolveWorkerUrl({
      env: { CLAUDE_MEM_WORKER_PORT: "70000" },
      readFile: noFile,
    });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:${DEFAULT_WORKER_PORT}`);
  });

  it("takes the host from env when set", () => {
    const url = resolveWorkerUrl({
      env: {
        CLAUDE_MEM_WORKER_HOST: "localhost",
        CLAUDE_MEM_WORKER_PORT: "3777",
      },
      readFile: noFile,
    });
    expect(url).toBe("http://localhost:3777");
  });

  it("survives a throwing readFile", () => {
    const url = resolveWorkerUrl({
      env: {},
      readFile: () => {
        throw new Error("disk gone");
      },
    });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:${DEFAULT_WORKER_PORT}`);
  });
});

describe("resolveWorkerUrl with an empty env var", () => {
  it("falls through to the settings file", () => {
    expect(
      resolveWorkerUrl({
        env: { CLAUDE_MEM_WORKER_PORT: " ", CLAUDE_MEM_WORKER_HOST: "" },
        readFile: () =>
          JSON.stringify({
            CLAUDE_MEM_WORKER_PORT: "4888",
            CLAUDE_MEM_WORKER_HOST: "10.0.0.2",
          }),
      }),
    ).toBe("http://10.0.0.2:4888");
  });
});

describe("resolveProxyToken", () => {
  it("reads and trims the file named by CLAUDE_MEM_PROXY_TOKEN_FILE", () => {
    const seen: string[] = [];
    const token = resolveProxyToken({
      env: { CLAUDE_MEM_PROXY_TOKEN_FILE: "/run/tb-secrets/synthetic" },
      readFile: (path) => {
        seen.push(path);
        return "synthetic-proxy-token\n";
      },
    });
    expect(token).toBe("synthetic-proxy-token");
    expect(seen).toEqual(["/run/tb-secrets/synthetic"]);
  });

  it("gives nothing without the variable and reads no file", () => {
    const seen: string[] = [];
    const token = resolveProxyToken({
      env: { CLAUDE_MEM_PROXY_TOKEN_FILE: " " },
      readFile: (path) => {
        seen.push(path);
        return "synthetic-proxy-token";
      },
    });
    expect(token).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("gives nothing for a missing or empty file (rollout mode)", () => {
    const env = { CLAUDE_MEM_PROXY_TOKEN_FILE: "/run/tb-secrets/synthetic" };
    expect(resolveProxyToken({ env, readFile: noFile })).toBeUndefined();
    expect(resolveProxyToken({ env, readFile: () => "\n" })).toBeUndefined();
  });
});
