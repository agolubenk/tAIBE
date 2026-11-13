import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vite-plus/test";
import type { QueueClient, QueueDoc } from "../owner-queue/queue-client";
import type { OwnerQueueConfig } from "../owner-queue/queue-config";
import { assertQueueItemVisible } from "./queue-item-check";

const config: OwnerQueueConfig = {
  url: "https://queue.example.test",
  tokenFile: "/nonexistent/token",
  tokenName: "token:t-boards",
  products: new Map([["ws-1", "taibe"]]),
};

function clientGetting(get: QueueClient["get"]) {
  const asked: string[] = [];
  const client = (): QueueClient => ({
    get: async (collection, id) => {
      asked.push(`${collection}/${id}`);
      return get(collection, id);
    },
    put: async () => {
      throw new Error("not used");
    },
    patch: async () => {
      throw new Error("not used");
    },
    history: async () => [],
  });
  return { client, asked };
}

async function statusOf(promise: Promise<void>) {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof HTTPException) return error.status;
    throw error;
  }
}

const doc: QueueDoc = {
  id: "d-tb113-mem-1311",
  data: {},
  version: 1,
  updatedAt: 1,
};

describe("assertQueueItemVisible", () => {
  it("passes for an item the queue returns", async () => {
    const { client, asked } = clientGetting(async () => doc);
    expect(
      await statusOf(
        assertQueueItemVisible("ws-1", "d-tb113-mem-1311", { config, client }),
      ),
    ).toBe(200);
    expect(asked).toEqual(["items/d-tb113-mem-1311"]);
  });

  it("answers 404 for an item the queue does not have or does not show", async () => {
    const { client } = clientGetting(async () => null);
    expect(
      await statusOf(
        assertQueueItemVisible("ws-1", "d-unknown-1311", { config, client }),
      ),
    ).toBe(404);
  });

  it("answers 503 when the queue fails", async () => {
    const { client } = clientGetting(async () => {
      throw new Error("Owner queue GET items/d-x-1 failed: 502");
    });
    expect(
      await statusOf(
        assertQueueItemVisible("ws-1", "d-x-1", { config, client }),
      ),
    ).toBe(503);
  });

  it("answers 503 and asks nothing when this workspace is not linked", async () => {
    const { client, asked } = clientGetting(async () => doc);
    expect(
      await statusOf(
        assertQueueItemVisible("ws-2", "d-x-1", { config, client }),
      ),
    ).toBe(503);
    expect(asked).toEqual([]);
  });

  it("answers 503 and asks nothing when the queue is not linked", async () => {
    const { client, asked } = clientGetting(async () => doc);
    expect(
      await statusOf(
        assertQueueItemVisible("ws-1", "d-x-1", { config: null, client }),
      ),
    ).toBe(503);
    expect(asked).toEqual([]);
  });
});
