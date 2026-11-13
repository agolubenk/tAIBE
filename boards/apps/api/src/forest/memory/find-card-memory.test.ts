import type {
  CardMemoryAnswer,
  CardMemoryClient,
  CardMemoryKeyResult,
} from "@kaneo/claude-mem-reader";
import { describe, expect, it } from "vite-plus/test";
import { labelBySource, orderMemoryKeys } from "./card-memory-keys";
import {
  createCardMemoryFinder,
  FAILED_MS,
  FRESH_MS,
  STALE_MS,
} from "./find-card-memory";

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
  // Control lens on 20290bce9: no searchable key is not a proxy failure.
  it("answers an empty available list for no keys and does not call the proxy", async () => {
    const { client, calls } = scriptedClient([]);
    const find = createCardMemoryFinder(client);
    expect(await find([])).toEqual({
      available: true,
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
    clock.tick(FAILED_MS);
    expect(await find(["TB-113"])).toMatchObject({ available: false });
    expect(calls).toHaveLength(3);
  });

  it("does not ask the proxy for 10 s after a failure, for any key set", async () => {
    const clock = clockAt(2_000_000);
    const { client, calls } = scriptedClient([5, new Error("proxy down"), 6]);
    const find = createCardMemoryFinder(client, () => clock.now);

    await find(["TB-1"]);
    clock.tick(FRESH_MS);
    expect(await find(["TB-1"])).toMatchObject({ stale: true });
    expect(calls).toHaveLength(2);

    clock.tick(FAILED_MS - 1);
    expect(await find(["TB-1"])).toMatchObject({
      available: true,
      stale: true,
    });
    expect(await find(["TB-2"])).toMatchObject({ available: false });
    expect(calls).toHaveLength(2);

    clock.tick(1);
    expect(await find(["TB-2"])).toMatchObject({
      available: true,
      stale: false,
    });
    expect(calls).toHaveLength(3);
  });

  it("answers unavailable when the first call fails", async () => {
    const { client } = scriptedClient([new Error("proxy down")]);
    const find = createCardMemoryFinder(client);
    expect(await find(["TB-1"])).toMatchObject({ available: false });
  });

  // TB-121: a burst of calls for one key set while the proxy is asked is one
  // request; a sleeping Mac fails it once, not once per call.
  it("shares one request among calls for the same key set that overlap it", async () => {
    const answers: ((value: CardMemoryAnswer) => void)[] = [];
    const calls: string[][] = [];
    const client: CardMemoryClient = {
      find(keys) {
        calls.push(keys);
        return new Promise((resolve) => answers.push(resolve));
      },
    };
    const find = createCardMemoryFinder(client, () => 3_000_000);

    const first = find(["TB-1", "TB-2"]);
    const second = find(["TB-2", "TB-1"]);
    const other = find(["TB-3"]);
    expect(calls).toEqual([["TB-1", "TB-2"], ["TB-3"]]);

    answers[0]?.({ keys: [result("TB-1", 4), result("TB-2", 4)] });
    answers[1]?.({ keys: [result("TB-3", 1)] });
    expect((await first).keys).toHaveLength(2);
    expect(await second).toEqual(await first);
    expect((await other).keys[0]?.count).toBe(1);
  });

  it("asks again after a shared request has settled", async () => {
    const clock = clockAt(4_000_000);
    const { client, calls } = scriptedClient([new Error("proxy down"), 8]);
    const find = createCardMemoryFinder(client, () => clock.now);

    const [one, two] = await Promise.all([find(["TB-1"]), find(["TB-1"])]);
    expect(one).toMatchObject({ available: false });
    expect(two).toMatchObject({ available: false });
    expect(calls).toHaveLength(1);

    clock.tick(FAILED_MS);
    expect((await find(["TB-1"])).keys[0]?.count).toBe(8);
    expect(calls).toHaveLength(2);
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
        ["g88se9086hag2gzm0fgjul5w", "id"],
        ["TB-108", "key"],
        [null, "backlog"],
        ["TB-108", "backlog"],
        ["free text", "backlog"],
        // TB-121: a lowercase Backlog ID is no queue id and is left out.
        ["auth-refactor", "backlog"],
        [undefined, "queue"],
        ["s-tb-update-tb108", "queue"],
        ["d-tb113-mem-1311", "queue"],
        ["m-166-1311", "queue"],
        ["s-tb-mcp-restart-1311", "queue"],
        ["q-extra-1311", "queue"],
      ]),
    ).toEqual([
      { key: "g88se9086hag2gzm0fgjul5w", source: "id" },
      { key: "TB-108", source: "key" },
      { key: "s-tb-update-tb108", source: "queue" },
      { key: "d-tb113-mem-1311", source: "queue" },
      { key: "m-166-1311", source: "queue" },
      { key: "s-tb-mcp-restart-1311", source: "queue" },
    ]);
  });
});

// TB-121: the proxy labels a key by its form, so a Backlog ID «R-036» came
// back as a card key. The API labels it by where the key came from.
describe("labelBySource", () => {
  it("labels each key by its source and keeps the rest of the answer", () => {
    const memory = {
      available: true,
      stale: false,
      fetchedAt: new Date(1_000),
      keys: [result("TB-108", 2), result("R-036", 3)],
    };
    const labelled = labelBySource(memory, [
      { key: "TB-108", source: "key" },
      { key: "R-036", source: "backlog" },
    ]);
    expect(labelled.keys.map((k) => [k.key, k.matchedOn, k.count])).toEqual([
      ["TB-108", "key", 2],
      ["R-036", "backlog", 3],
    ]);
    expect(labelled.fetchedAt).toEqual(new Date(1_000));
  });
});
