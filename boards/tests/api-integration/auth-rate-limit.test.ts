import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { resetTestDatabase } from "./helpers/database";

// setup.ts turns the limiter off for all suites; this one needs it on. The
// auth module reads the switch once, at import, so it is set before imports.
vi.hoisted(() => {
  process.env.DISABLE_AUTH_RATE_LIMIT = "false";
});

type Server = ReturnType<typeof serve>;

async function listen(trustedProxies: string) {
  vi.stubEnv("TRUSTED_PROXIES", trustedProxies);
  const { createApp } = await import("../../apps/api/src/index");
  const server = serve({
    fetch: createApp().app.fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  await once(server, "listening");
  vi.unstubAllEnvs();
  return server;
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function signIn(server: Server, forwardedFor: string) {
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: "http://localhost:5173",
      "x-forwarded-for": forwardedFor,
    },
    body: JSON.stringify({
      email: "nobody@example.com",
      password: "wrong-password-123",
    }),
  });
}

beforeEach(async () => {
  await resetTestDatabase();
});

describe("sign-in limiter per client IP (TB-31 R-8)", () => {
  describe("behind a trusted proxy", () => {
    let server: Server;
    beforeAll(async () => {
      server = await listen("127.0.0.0/8");
    });
    afterAll(() => close(server));

    it("gives two clients two buckets and the 6th try in a minute a 429", async () => {
      for (let i = 0; i < 5; i++) {
        const response = await signIn(server, "10.77.0.2");
        expect(response.status, await response.text()).toBe(401);
      }
      const limited = await signIn(server, "10.77.0.2");
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" });

      const other = await signIn(server, "10.77.0.3");
      expect(other.status, await other.text()).toBe(401);
    });
  });

  describe("without a trusted proxy", () => {
    let server: Server;
    beforeAll(async () => {
      server = await listen("none");
    });
    afterAll(() => close(server));

    it("puts every client behind the proxy into the proxy's bucket", async () => {
      for (let i = 0; i < 5; i++) {
        const response = await signIn(server, `10.77.1.${i + 1}`);
        expect(response.status, await response.text()).toBe(401);
      }
      const limited = await signIn(server, "10.77.1.99");
      expect(limited.status).toBe(429);
    });
  });
});
