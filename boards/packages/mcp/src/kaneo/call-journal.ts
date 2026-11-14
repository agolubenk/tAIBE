import { randomUUID } from "node:crypto";
import type { ToolCall } from "../tools/register-tool.js";
import { type AgentIdentity, identityKey } from "./agent-identity.js";

// TB-135 (R-036): a stdio server keeps no journal, so the calls it serves go
// to the API in batches, each batch under the session that made its calls.
export const JOURNAL_PATH = "/api/agent-journal/mcp-calls";

export type JournalCall = Omit<ToolCall, "identity"> & { id: string };
export type SendCalls = (
  identity: AgentIdentity | undefined,
  calls: JournalCall[],
) => Promise<void>;

// A batch goes at 20 calls, 256 KB of arguments or 15 s after its first call:
// at most 4 POSTs a minute from a quiet session, about one per 20 calls from
// a busy one, all under the same key rate limit as the tools themselves.
export const JOURNAL_LIMITS = {
  batch: 20,
  maxBytes: 256_000,
  waitMs: 15_000,
  // While the API is away: the oldest calls go first, a call goes after
  // three failed sends, and no more than four batches wait for an answer.
  maxHeld: 200,
  tries: 3,
  inFlight: 4,
};

type Held = {
  key: string;
  identity?: AgentIdentity;
  call: JournalCall;
  size: number;
  tries: number;
};

export class CallJournal {
  private held: Held[] = [];
  private heldBytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly sending = new Set<Promise<void>>();
  private warned = false;
  private closing = false;

  constructor(
    private readonly send: SendCalls,
    private readonly limits = JOURNAL_LIMITS,
    private readonly warn: (message: string) => void = (message) =>
      console.error(message),
  ) {}

  // The tool has answered by now: nothing here may throw or wait.
  readonly record = (call: ToolCall): void => {
    const { identity, ...rest } = call;
    const size = JSON.stringify(rest.args ?? null)?.length ?? 4;
    this.hold([
      {
        key: identity ? identityKey(identity) : "",
        identity,
        call: { ...rest, id: randomUUID() },
        size,
        tries: 0,
      },
    ]);
    const full =
      this.held.length >= this.limits.batch ||
      this.heldBytes >= this.limits.maxBytes;
    if (full) void this.flush();
    else this.arm();
  };

  // Sends what is held; resolves when every batch in flight has an answer.
  flush(): Promise<void> {
    this.disarm();
    if (this.held.length > 0) {
      if (this.closing || this.sending.size < this.limits.inFlight) {
        this.sendHeld();
      } else {
        this.arm();
      }
    }
    return Promise.allSettled([...this.sending]).then(() => undefined);
  }

  // Before the process ends: one last send of everything, no retries after.
  close(): Promise<void> {
    this.closing = true;
    return this.flush();
  }

  private sendHeld() {
    const taken = this.held;
    this.held = [];
    this.heldBytes = 0;
    const groups = new Map<string, Held[]>();
    for (const item of taken) {
      groups.set(item.key, [...(groups.get(item.key) ?? []), item]);
    }
    for (const group of groups.values()) {
      for (let at = 0; at < group.length; at += this.limits.batch) {
        this.sendBatch(group.slice(at, at + this.limits.batch));
      }
    }
  }

  private sendBatch(batch: Held[]) {
    const sent = Promise.resolve()
      .then(() =>
        this.send(
          batch[0]?.identity,
          batch.map((item) => item.call),
        ),
      )
      .catch((error: unknown) => this.failed(batch, error))
      .finally(() => this.sending.delete(sent));
    this.sending.add(sent);
  }

  // The ids make a second send safe: the API keeps one row per id.
  private failed(batch: Held[], error: unknown) {
    if (!this.warned) {
      this.warned = true;
      const reason = error instanceof Error ? error.message : String(error);
      this.warn(
        `kaneo-mcp: calls not journaled (${reason}); the tools still answer, later failures are not repeated`,
      );
    }
    if (this.closing) return;
    const again = batch
      .map((item) => ({ ...item, tries: item.tries + 1 }))
      .filter((item) => item.tries < this.limits.tries);
    this.hold(again, true);
    this.arm();
  }

  private hold(items: Held[], older = false) {
    this.held = older ? [...items, ...this.held] : [...this.held, ...items];
    for (const item of items) this.heldBytes += item.size;
    while (this.held.length > this.limits.maxHeld) {
      const dropped = this.held.shift();
      this.heldBytes -= dropped?.size ?? 0;
    }
  }

  private arm() {
    if (this.timer || this.held.length === 0) return;
    this.timer = setTimeout(() => void this.flush(), this.limits.waitMs);
    this.timer.unref?.();
  }

  private disarm() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
