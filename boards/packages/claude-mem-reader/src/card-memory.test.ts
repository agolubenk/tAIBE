import { describe, expect, it, vi } from "vite-plus/test";
import { createCardMemoryClient, parseCardMemory } from "./card-memory.js";
import { ClaudeMemHttpError } from "./client.js";
import { memoryKeyForm } from "./memory-keys.js";
import type { FetchLike } from "./types.js";

const answer = {
  keys: [
    {
      key: "TB-108",
      matchedOn: "key",
      count: 3,
      capped: false,
      latest: [
        { id: 7, title: "a", project: "p", createdAt: "2026-11-13T10:00:00Z" },
      ],
    },
  ],
};

function client(status = 200, body: unknown = answer) {
  const fetch = vi.fn<FetchLike>(
    async () => new Response(JSON.stringify(body), { status }),
  );
  return {
    fetch,
    memory: createCardMemoryClient({
      baseUrl: "http://proxy/",
      fetch,
      proxyToken: () => "t".repeat(40),
    }),
  };
}

describe("memoryKeyForm (TB-113)", () => {
  it("knows a card id, a card key and a queue item id", () => {
    expect(memoryKeyForm("g88se9086hag2gzm0fgjul5w")).toBe("id");
    expect(memoryKeyForm("TB-108")).toBe("key");
    expect(memoryKeyForm("d-tb113-mem-1311")).toBe("queue");
  });

  // Control lens on 20290bce9: the queue panel's project key is one letter.
  it("knows a one-letter project key and refuses an 11-letter one", () => {
    expect(memoryKeyForm("Q-12")).toBe("key");
    expect(memoryKeyForm("ABCDEFGHIJ-1")).toBe("key");
    expect(memoryKeyForm("ABCDEFGHIJK-1")).toBeNull();
    expect(memoryKeyForm("HR-OPS-1")).toBeNull();
  });

  it("refuses free words, quotes, wildcards and too long ids", () => {
    for (const word of ["main", "PR", '"TB-1"', "TB-1*", "a b", "tb-108x!"]) {
      expect(memoryKeyForm(word)).toBeNull();
    }
    expect(memoryKeyForm(`a-${"b".repeat(63)}`)).toBeNull();
  });
});

describe("createCardMemoryClient", () => {
  it("asks the proxy route with one key parameter per key and the token", async () => {
    const { fetch, memory } = client();

    expect(await memory.find(["TB-108", "d-tb113-mem-1311"])).toEqual(answer);

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "http://proxy/api/card-memory?key=TB-108&key=d-tb113-mem-1311",
    );
    expect(new Headers(init?.headers).get("x-cmem-proxy-token")).toHaveLength(
      40,
    );
  });

  it("does not send a word that is no key, nor more than 6 keys", async () => {
    const { fetch, memory } = client();

    await expect(memory.find(["main"])).rejects.toThrow(TypeError);
    await expect(memory.find([])).rejects.toThrow(TypeError);
    await expect(
      memory.find(["A1-1", "A1-2", "A1-3", "A1-4", "A1-5", "A1-6", "A1-7"]),
    ).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the keys out of the error a 503 raises", async () => {
    const { memory } = client(503, { error: "schema_changed" });

    const error = await memory.find(["TB-108"]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClaudeMemHttpError);
    expect((error as ClaudeMemHttpError).status).toBe(503);
    expect((error as Error).message).not.toContain("TB-108");
  });
});

describe("parseCardMemory", () => {
  it("drops malformed entries and refuses a body without keys", () => {
    expect(
      parseCardMemory({
        keys: [answer.keys[0], { key: "x" }, { ...answer.keys[0], latest: 1 }],
      }).keys,
    ).toHaveLength(1);
    expect(() => parseCardMemory({ items: [] })).toThrow(TypeError);
  });
});
