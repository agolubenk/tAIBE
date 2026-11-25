import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { withAgentIdentity } from "./agent-identity.js";
import { AgentKeys } from "./agent-keys.js";
import { KaneoClient } from "./client.js";

function issued(key: string, name = "bb · Claude Code") {
  return new Response(
    JSON.stringify({
      key,
      keyId: `id-${key}`,
      agent: { id: "agent-1", name, harness: "claude-code", session: "bb" },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    { status: 200 },
  );
}

const bb = { harness: "claude-code", session: "bb" };

describe("AgentKeys (R-010)", () => {
  it("asks once per session and keeps the key", async () => {
    const issue = vi.fn().mockResolvedValue(issued("k1"));
    const keys = new AgentKeys(issue);
    const [a, b] = await Promise.all([keys.get(bb), keys.get(bb)]);
    expect(a?.key).toBe("k1");
    expect(b?.key).toBe("k1");
    expect(await keys.get({ ...bb, session: "BB" })).toBe(a);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("renews a key that is about to expire", async () => {
    const soon = new Response(
      JSON.stringify({
        key: "old",
        agent: { id: "a", name: "bb", harness: "claude-code", session: "bb" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      { status: 200 },
    );
    const issue = vi
      .fn()
      .mockResolvedValueOnce(soon)
      .mockResolvedValueOnce(issued("new"));
    const keys = new AgentKeys(issue);
    expect((await keys.get(bb))?.key).toBe("old");
    expect((await keys.get(bb))?.key).toBe("new");
  });

  it("does not keep a refusal", async () => {
    const issue = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "agent_forbidden: disabled" }), {
          status: 403,
        }),
      )
      .mockResolvedValueOnce(issued("k2"));
    const keys = new AgentKeys(issue);
    await expect(keys.get(bb)).rejects.toThrow("agent_forbidden");
    expect((await keys.get(bb))?.key).toBe("k2");
  });

  it("gives up on a server without agent identities", async () => {
    const issue = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    const keys = new AgentKeys(issue);
    expect(await keys.get(bb)).toBeNull();
    expect(await keys.get({ harness: "codex" })).toBeNull();
    expect(issue).toHaveBeenCalledTimes(1);
  });
});

describe("KaneoClient with agent sessions (R-010)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function client() {
    const auth = {
      usingApiKey: true,
      getAccessToken: vi.fn().mockResolvedValue("owner-key"),
      clearToken: vi.fn(),
    };
    return new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
      agentSessions: true,
    });
  }

  function bearer(call: unknown[]) {
    const init = call[1] as RequestInit;
    return new Headers(init.headers).get("Authorization");
  }

  it("sends a session's call with its agent key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(issued("agent-key"))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await withAgentIdentity(bb, () => client().json("/api/project"));

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/api/agent-identity/session",
    );
    expect(bearer(fetchMock.mock.calls[0] ?? [])).toBe("Bearer owner-key");
    expect(bearer(fetchMock.mock.calls[1] ?? [])).toBe("Bearer agent-key");
  });

  it("gets a new key once when the old one is refused", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(issued("stale"))
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(issued("fresh"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await withAgentIdentity(bb, () => client().json("/api/project"));

    expect(bearer(fetchMock.mock.calls[3] ?? [])).toBe("Bearer fresh");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("falls back to the owner's key and a session header on an old server", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await withAgentIdentity(bb, () => client().json("/api/project"));

    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer owner-key");
    expect(headers.get("x-t-boards-session")).toBe("bb");
  });

  it("uses the owner's key outside a tool call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await client().json("/api/project");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bearer(fetchMock.mock.calls[0] ?? [])).toBe("Bearer owner-key");
  });

  // TB-31 R-5, owner taibe-d-tb31-agent-key-1811 = A.
  const notFresh = () =>
    new Response(
      JSON.stringify({
        code: "SESSION_NOT_FRESH",
        message: "Confirm it's you to continue.",
        methods: ["password"],
      }),
      { status: 403 },
    );

  function deviceClient(tokens: string[], usingApiKey = false) {
    const getAccessToken = vi.fn();
    for (const token of tokens) getAccessToken.mockResolvedValueOnce(token);
    const auth = { usingApiKey, getAccessToken, clearToken: vi.fn() };
    const kaneo = new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
      agentSessions: true,
    });
    return { auth, kaneo };
  }

  it("signs in on the device once more when an old device session is refused", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(notFresh())
      .mockResolvedValueOnce(issued("agent-key"))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const { auth, kaneo } = deviceClient(["old", "old", "new"]);

    await withAgentIdentity(bb, () => kaneo.json("/api/project"));

    expect(auth.clearToken).toHaveBeenCalledTimes(1);
    expect(bearer(fetchMock.mock.calls[1] ?? [])).toBe("Bearer new");
    expect(bearer(fetchMock.mock.calls[2] ?? [])).toBe("Bearer agent-key");
  });

  it("keeps a token another call already renewed, and asks only once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(notFresh())
      .mockResolvedValueOnce(notFresh());
    globalThis.fetch = fetchMock as typeof fetch;
    const { auth, kaneo } = deviceClient(["old", "new", "new"]);

    await expect(
      withAgentIdentity(bb, () => kaneo.json("/api/project")),
    ).rejects.toThrow("SESSION_NOT_FRESH) even after a new device sign-in");
    expect(auth.clearToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a key is never signed in again", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(notFresh());
    globalThis.fetch = fetchMock as typeof fetch;
    const { auth, kaneo } = deviceClient(["owner-key"], true);

    await expect(
      withAgentIdentity(bb, () => kaneo.json("/api/project")),
    ).rejects.toThrow("SESSION_NOT_FRESH");
    expect(auth.clearToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
