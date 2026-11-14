import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { ToolCall } from "../tools/register-tool.js";
import type { AgentIdentity } from "./agent-identity.js";
import {
  CallJournal,
  JOURNAL_LIMITS,
  type JournalCall,
  type SendCalls,
} from "./call-journal.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const night: AgentIdentity = { harness: "claude-code", session: "night-1" };
const day: AgentIdentity = { harness: "claude-code", session: "day-1" };

const call = (tool: string, identity?: AgentIdentity): ToolCall => ({
  tool,
  args: { taskId: "t1" },
  ok: true,
  bytes: 10,
  tokens: 4,
  ms: 2,
  ...(identity ? { identity } : {}),
});

type Sent = { identity?: AgentIdentity; calls: JournalCall[] };

function journal(
  send: (sent: Sent) => Promise<void> = async () => {},
  limits: Partial<typeof JOURNAL_LIMITS> = {},
) {
  const sent: Sent[] = [];
  const warn = vi.fn();
  const sendCalls: SendCalls = (identity, calls) => {
    const batch = { identity, calls };
    sent.push(batch);
    return send(batch);
  };
  const j = new CallJournal(sendCalls, { ...JOURNAL_LIMITS, ...limits }, warn);
  return { j, sent, warn };
}

// TB-135 (R-036): the stdio server's calls reach the API journal.
describe("CallJournal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a full batch at once, one POST per session, each call with its own id", async () => {
    const { j, sent } = journal(undefined, { batch: 4 });

    j.record(call("get_task", night));
    j.record(call("get_task", day));
    j.record(call("list_tasks", night));
    expect(sent).toHaveLength(0);
    j.record(call("whoami"));
    await j.flush();

    expect(sent.map((s) => [s.identity, s.calls.map((c) => c.tool)])).toEqual([
      [night, ["get_task", "list_tasks"]],
      [day, ["get_task"]],
      [undefined, ["whoami"]],
    ]);
    const ids = sent.flatMap((s) => s.calls.map((c) => c.id));
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(UUID);
    expect(sent[0]?.calls[0]).not.toHaveProperty("identity");
  });

  it("sends a quiet session's calls after the wait", async () => {
    const { j, sent } = journal();

    j.record(call("get_task", night));
    await vi.advanceTimersByTimeAsync(JOURNAL_LIMITS.waitMs - 1);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(sent).toHaveLength(1);
  });

  it("splits what was held into batches of the limit", async () => {
    const { j, sent } = journal(undefined, { batch: 3 });

    for (let n = 0; n < 7; n += 1) j.record(call(`t${n}`, night));
    await j.flush();

    expect(sent.map((s) => s.calls.length)).toEqual([3, 3, 1]);
  });

  it("holds new calls while the in-flight limit of sends waits for an answer", async () => {
    const { j, sent } = journal(() => new Promise(() => {}), {
      batch: 1,
      inFlight: 1,
    });

    j.record(call("a", night));
    j.record(call("b", night));
    j.record(call("c", night));
    await vi.advanceTimersByTimeAsync(JOURNAL_LIMITS.waitMs);

    expect(sent.map((s) => s.calls[0]?.tool)).toEqual(["a"]);
  });

  it("sends a failed batch again with the same ids, gives up after three tries and warns once", async () => {
    const { j, sent, warn } = journal(async () => {
      throw new Error("503");
    });

    j.record(call("get_task", night));
    await j.flush();
    await vi.advanceTimersByTimeAsync(JOURNAL_LIMITS.waitMs);
    await vi.advanceTimersByTimeAsync(JOURNAL_LIMITS.waitMs);
    await vi.advanceTimersByTimeAsync(JOURNAL_LIMITS.waitMs * 3);

    expect(sent).toHaveLength(JOURNAL_LIMITS.tries);
    expect(new Set(sent.map((s) => s.calls[0]?.id)).size).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("503");
  });

  it("keeps the newest calls when the API is away", async () => {
    const { j, sent } = journal(
      async () => {
        throw new Error("down");
      },
      { batch: 100, maxHeld: 3 },
    );

    for (let n = 0; n < 5; n += 1) j.record(call(`t${n}`, night));
    await j.close();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.calls.map((c) => c.tool)).toEqual(["t2", "t3", "t4"]);
  });

  it("sends everything on close, past the in-flight limit, and retries nothing after", async () => {
    let fail = true;
    const { j, sent } = journal(
      async () => {
        if (fail) throw new Error("down");
      },
      { batch: 1, inFlight: 1 },
    );

    j.record(call("a", night));
    j.record(call("b", day));
    j.record(call("c"));
    await j.close();
    fail = false;
    await vi.advanceTimersByTimeAsync(JOURNAL_LIMITS.waitMs * 2);

    expect(sent.map((s) => s.calls[0]?.tool).sort()).toEqual(["a", "b", "c"]);
    expect(sent).toHaveLength(3);
  });

  it("never throws into the tool, even when the sender throws at once", async () => {
    const throwing = new CallJournal(
      () => {
        throw new Error("sync");
      },
      { ...JOURNAL_LIMITS, batch: 1 },
      () => {},
    );

    expect(() => throwing.record(call("get_task", night))).not.toThrow();
    await expect(throwing.close()).resolves.toBeUndefined();
  });
});
