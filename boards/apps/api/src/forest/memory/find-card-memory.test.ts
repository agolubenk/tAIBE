import type {
  CardMemoryAnswer,
  CardMemoryClient,
  CardMemoryKeyResult,
} from "@kaneo/claude-mem-reader";
import { describe, expect, it } from "vite-plus/test";
import { orderMemoryKeys } from "./card-memory-keys";
import { createCardMemoryFinder, FRESH_MS, STALE_MS } from "./find-card-memory";

function result(key: string, count: number): CardMemoryKeyResult {
  return {
    key,
    matchedOn: "key",
    count,
    capped: false,
    latest: [
      {
        id: count,
        title: `About ${key}`,
        project: "t-boards",
        createdAt: "2026-11-13T10:00:00.000Z",
      },
    ],
  };
}

// A client that answers from a script: a number is a count for every key,
// an Error is thrown. It records each call.
function scriptedClient(script: (number | Error)[]) {
  const calls: string[][] = [];
  const client: CardMemoryClient = {
    async find(keys) {
      calls.push(keys);
      const step = script.shift();
      if (step === undefined) throw new Error("script is over");
      if (step instanceof Error) throw step;
      const answer: CardMemoryAnswer = {
        keys: keys.map((key) => result(key, step)),
      };
      return answer;
    },
  };
  return { client, calls };
}

function clockAt(start: number) {
  const clock = { now: start, tick: (ms: number) => (clock.now += ms) };
  return clock;
}

describe("createCardMemoryFinder", () => {
  it("answers unavailable for no keys and does not call the proxy", async () => {
    const { client, calls } = scriptedClient([]);
    const find = createCardMemoryFinder(client);
    expect(await find([])).toEqual({
      available: false,
      stale: false,
      fetchedAt: null,
      keys: [],
    });
    expect(calls).toHaveLength(0);
  });

  it("reuses a fresh answer for a minute, for the same key set in any order", async () => {
    const clock = clockAt(1_000_000);
    const { client, calls } = scriptedClient([3, 7]);
    const find = createCardMemoryFinder(client, () => clock.now);

    const first = await find(["TB-108", "g88se9086hag2gzm0fgjul5w"]);
    expect(first).toMatchObject({ available: true, stale: false });
    expect(first.keys[0]?.count).toBe(3);
    expect(first.fetchedAt?.getTime()).toBe(1_000_000);

    clock.tick(FRESH_MS - 1);
    const second = await find(["g88se9086hag2gzm0fgjul5w", "TB-108"]);
    expect(second.keys[0]?.count).toBe(3);
    expect(calls).toHaveLength(1);

    clock.tick(1);
    const third = await find(["TB-108", "g88se9086hag2gzm0fgjul5w"]);
    expect(third.keys[0]?.count).toBe(7);
    expect(calls).toHaveLength(2);
  });

  it("returns the last answer as stale when the proxy fails within a day", async () => {
    const clock = clockAt(5_000_000);
    const { client } = scriptedClient([4, new Error("proxy down")]);
    const find = createCardMemoryFinder(client, () => clock.now);

    await find(["TB-113"]);
    clock.tick(STALE_MS - 1);
    const stale = await find(["TB-113"]);
    expect(stale).toMatchObject({ available: true, stale: true });
    expect(stale.fetchedAt?.getTime()).toBe(5_000_000);
    expect(stale.keys[0]?.count).toBe(4);
  });

  it("answers unavailable when the proxy fails and the last answer is a day old", async () => {
    const clock = clockAt(9_000_000);
    const { client, calls } = scriptedClient([
      2,
      new Error("proxy down"),
      new Error("proxy down"),
    ]);
    const find = createCardMemoryFinder(client, () => clock.now);

    await find(["TB-113"]);
    clock.tick(STALE_MS);
    expect(await find(["TB-113"])).toMatchObject({
      available: false,
      stale: false,
      keys: [],
    });
    // The old answer is dropped, not shown again on the next failure.
    clock.tick(1);
    expect(await find(["TB-113"])).toMatchObject({ available: false });
    expect(calls).toHaveLength(3);
  });

  it("answers unavailable when the first call fails", async () => {
    const { client } = scriptedClient([new Error("proxy down")]);
    const find = createCardMemoryFinder(client);
    expect(await find(["TB-1"])).toMatchObject({ available: false });
  });

  it("keeps separate answers for separate key sets", async () => {
    const clock = clockAt(0);
    const { client, calls } = scriptedClient([1, 2]);
    const find = createCardMemoryFinder(client, () => clock.now);
    expect((await find(["TB-1"])).keys[0]?.count).toBe(1);
    expect((await find(["TB-2"])).keys[0]?.count).toBe(2);
    expect((await find(["TB-1"])).keys[0]?.count).toBe(1);
    expect(calls).toHaveLength(2);
  });
});

describe("orderMemoryKeys", () => {
  it("keeps valid keys in order, drops repeats, empties and other words, caps at 6", () => {
    expect(
      orderMemoryKeys([
        "g88se9086hag2gzm0fgjul5w",
        "TB-108",
        null,
        "TB-108",
        "free text",
        undefined,
        "s-tb-update-tb108",
        "d-tb113-mem-1311",
        "m-166-1311",
        "s-tb-mcp-restart-1311",
        "q-extra-1311",
      ]),
    ).toEqual([
      "g88se9086hag2gzm0fgjul5w",
      "TB-108",
      "s-tb-update-tb108",
      "d-tb113-mem-1311",
      "m-166-1311",
      "s-tb-mcp-restart-1311",
    ]);
  });
});
