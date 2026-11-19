import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  eachRow,
  REJECT_PAUSE_MS,
  resetRejectedForTest,
  withoutPaused,
} from "./each-row";
import {
  httpQueueClient,
  QueueConflict,
  QueueRejected,
  QueueThrottled,
} from "./queue-client";

const rows = ["a", "b", "c"].map((id) => ({ id, workspaceId: "ws1" }));

describe("paused requests do not starve new ones (Control lens on #151)", () => {
  beforeEach(() => resetRejectedForTest());

  it("30 refused requests leave the share of the next pass to the new ones", async () => {
    const take = 30;
    const old = Array.from({ length: take }, (_, i) => ({
      id: `old${i}`,
      workspaceId: "ws1",
    }));
    const refuse = async () => {
      throw new QueueRejected("HTTP 422", 422);
    };
    await eachRow(
      old,
      refuse,
      vi.fn(async () => {}),
      () => 1000,
    );
    const fresh = [...old, { id: "new", workspaceId: "ws1" }];
    const seen: string[] = [];
    await eachRow(
      withoutPaused(fresh, () => 2000).slice(0, take),
      async (row) => {
        seen.push(row.id);
      },
      vi.fn(async () => {}),
      () => 2000,
    );
    expect(seen).toEqual(["new"]);
  });

  it("journals a refused request once, not once per pause", async () => {
    const journal = vi.fn(async () => {});
    const refuse = async () => {
      throw new QueueRejected("HTTP 422", 422);
    };
    const one = [{ id: "a", workspaceId: "ws1" }];
    await eachRow(one, refuse, journal, () => 0);
    await eachRow(one, refuse, journal, () => REJECT_PAUSE_MS);
    await eachRow(one, refuse, journal, () => 2 * REJECT_PAUSE_MS);
    expect(journal).toHaveBeenCalledTimes(1);
  });

  it("a failed journal write ends the pass and does not pause the request", async () => {
    const refuse = async () => {
      throw new QueueRejected("HTTP 422", 422);
    };
    const one = [{ id: "a", workspaceId: "ws1" }];
    await expect(
      eachRow(
        one,
        refuse,
        async () => {
          throw new Error("database down");
        },
        () => 0,
      ),
    ).rejects.toThrow("database down");
    expect(withoutPaused(one, () => 1)).toEqual(one);
  });
});

describe("eachRow (TB-110)", () => {
  beforeEach(() => resetRejectedForTest());

  it("a refused document skips only its request; the others still run", async () => {
    const seen: string[] = [];
    const journal = vi.fn(async () => {});
    await eachRow(
      rows,
      async (row) => {
        seen.push(row.id);
        if (row.id === "b") throw new QueueRejected("HTTP 422 links.0", 422);
      },
      journal,
      () => 1000,
    );
    expect(seen).toEqual(["a", "b", "c"]);
    expect(journal).toHaveBeenCalledTimes(1);
    expect(journal).toHaveBeenCalledWith(
      "ws1",
      "queue.item_rejected",
      "b",
      "HTTP 422 links.0",
    );
  });

  it("pauses the refused request, then tries it again", async () => {
    const journal = vi.fn(async () => {});
    const refuse = async (row: { id: string }) => {
      if (row.id === "b") throw new QueueRejected("HTTP 400", 400);
    };
    await eachRow(rows, refuse, journal, () => 1000);
    const seen: string[] = [];
    const record = async (row: { id: string }) => {
      seen.push(row.id);
    };
    await eachRow(rows, record, journal, () => 1000 + REJECT_PAUSE_MS - 1);
    expect(seen).toEqual(["a", "c"]);
    seen.length = 0;
    await eachRow(rows, record, journal, () => 1000 + REJECT_PAUSE_MS);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("a version race skips the item without a journal row", async () => {
    const journal = vi.fn(async () => {});
    const seen: string[] = [];
    await eachRow(
      rows,
      async (row) => {
        seen.push(row.id);
        if (row.id === "a") throw new QueueConflict("version");
      },
      journal,
    );
    expect(seen).toEqual(["a", "b", "c"]);
    expect(journal).not.toHaveBeenCalled();
  });

  it("any other failure ends the pass", async () => {
    const seen: string[] = [];
    await expect(
      eachRow(
        rows,
        async (row) => {
          seen.push(row.id);
          throw new Error("HTTP 503");
        },
        vi.fn(async () => {}),
      ),
    ).rejects.toThrow("HTTP 503");
    expect(seen).toEqual(["a"]);
  });
});

describe("httpQueueClient status mapping (TB-110)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const client = () => {
    const dir = mkdtempSync(join(tmpdir(), "oq-"));
    const tokenFile = join(dir, "oq_token");
    writeFileSync(tokenFile, "test-token");
    return httpQueueClient({
      url: "https://ops.test",
      tokenFile,
      tokenName: "token:t-boards",
      products: new Map([["ws1", "hr-helper"]]),
      plan: { products: new Map([["ws1", "hr-helper"]]) },
    });
  };
  const respond = (status: number, body: unknown) => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
  };

  it("422 and 400 are a refused document", async () => {
    respond(422, { error: "links.0: Expected object" });
    await expect(
      client().put("items", "d-tba-x", {}, 0),
    ).rejects.toBeInstanceOf(QueueRejected);
    respond(400, { error: "bad" });
    await expect(
      client().put("items", "d-tba-x", {}, 0),
    ).rejects.toBeInstanceOf(QueueRejected);
  });

  it("401, 429 and 503 stay general failures", async () => {
    for (const status of [401, 429, 503]) {
      respond(status, { error: "x" });
      const error = await client()
        .put("items", "d-tba-x", {}, 0)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(QueueRejected);
      expect(error).not.toBeInstanceOf(QueueConflict);
      // TB-119: the plan run tells a 429 from the others; the pass does not.
      expect(error instanceof QueueThrottled).toBe(status === 429);
    }
  });
});
