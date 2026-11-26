import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ApiError } from "../../errors/api-error";
import type { ForestActor } from "../actor";
import { ForestError } from "../forest-error";
import type { CardMetaRow } from "./card-meta";
import type { CardMetaPatch } from "./card-patch";
import { setCardMeta } from "./set-card-meta";

// TB-239: the order of the 409 answers of a card fields write. The lease
// comes first, then the markers against the row the write decides on, and a
// marker mismatch over a moved revision answers the revision conflict.
const m = vi.hoisted(() => ({
  lease: vi.fn(),
  load: vi.fn(),
  write: vi.fn(),
  journal: vi.fn(),
}));

vi.mock("../../database", () => ({ default: {} }));
vi.mock("../agent-guard/assert-agent-lease", () => ({
  assertAgentLease: m.lease,
}));
vi.mock("../agent-guard/agent-authored", () => ({
  isAgentAuthored: async () => true,
}));
vi.mock("../journal", () => ({ writeJournal: m.journal }));
vi.mock("./card-mirror", () => ({ isMirroredCard: () => false }));
vi.mock("./write-card-meta", () => ({ writeCardMeta: m.write }));
vi.mock("./card-meta", async (original) => ({
  ...(await original<typeof import("./card-meta")>()),
  loadCardMeta: m.load,
}));

const REVISION = "2026-11-26T10:00:00.123Z";
const LATER = "2026-11-26T10:05:00.456Z";
const agent: ForestActor = {
  kind: "agent",
  id: "dev-1",
  name: "dev-1",
  userId: "user-1",
};
const headers = {
  fencingToken: 1,
  groupKey: null,
  expectedRevision: undefined,
  approvalId: null,
};
const row = (updatedAt: string) =>
  ({
    taskId: "task-1",
    contextPack: "Context: stored",
    updatedAt: new Date(updatedAt),
  }) as unknown as CardMetaRow;
const mismatch = () =>
  new ApiError(409, {
    code: "REDACTED_MARKERS_MISMATCH",
    message: "A block with a [REDACTED:…] marker differs",
  });
const patch: CardMetaPatch = { contextPack: "Context: [REDACTED:api_key]" };

const write = (
  restore: (stored: CardMetaRow | undefined) => Promise<CardMetaPatch>,
  expectedRevision?: string | null,
) =>
  setCardMeta({
    workspaceId: "ws-1",
    taskId: "task-1",
    actor: agent,
    headers,
    patch,
    restore,
    expectedRevision,
  });

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("setCardMeta: the order of the 409 answers (TB-239)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.lease.mockResolvedValue(undefined);
    m.journal.mockResolvedValue(undefined);
  });

  it("answers the revision conflict for markers of a text that moved since the read", async () => {
    m.load.mockResolvedValue(row(LATER));
    const restore = vi.fn(async () => {
      throw mismatch();
    });

    const error = await caught(write(restore, REVISION));

    expect(error).toBeInstanceOf(ForestError);
    expect((error as ForestError).code).toBe("revision_conflict");
    expect((error as ForestError).status).toBe(409);
    expect((error as Error).message).toContain(LATER);
    expect(m.write).not.toHaveBeenCalled();
    expect(m.journal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        detail: expect.stringContaining("revision_conflict"),
      }),
    );
  });

  it("keeps the marker mismatch when the revision is the one the writer read", async () => {
    m.load.mockResolvedValue(row(REVISION));
    const error = await caught(
      write(async () => {
        throw mismatch();
      }, REVISION),
    );
    expect((error as ApiError).code).toBe("REDACTED_MARKERS_MISMATCH");
  });

  it("compares the revision as the write does: the same instant in another form is not a move", async () => {
    m.load.mockResolvedValue(row(REVISION));
    const error = await caught(
      write(async () => {
        throw mismatch();
      }, "2026-11-26T10:00:00.123000Z"),
    );
    expect((error as ApiError).code).toBe("REDACTED_MARKERS_MISMATCH");
  });

  it("keeps the marker mismatch for a write without expectedMetaRevision", async () => {
    m.load.mockResolvedValue(row(LATER));
    const error = await caught(
      write(async () => {
        throw mismatch();
      }),
    );
    expect((error as ApiError).code).toBe("REDACTED_MARKERS_MISMATCH");
  });

  it("answers the revision conflict when the writer expected no fields and a row is there", async () => {
    m.load.mockResolvedValue(row(LATER));
    const error = await caught(
      write(async () => {
        throw mismatch();
      }, null),
    );
    expect((error as ForestError).code).toBe("revision_conflict");
  });

  it("passes other errors of the restore through", async () => {
    m.load.mockResolvedValue(row(LATER));
    const other = new ApiError(400, { code: "OTHER", message: "other" });
    const error = await caught(
      write(async () => {
        throw other;
      }, REVISION),
    );
    expect(error).toBe(other);
  });

  it("checks the lease before the markers", async () => {
    m.lease.mockRejectedValue(new ForestError("lease_missing", "no lease"));
    const restore = vi.fn(async () => patch);

    const error = await caught(write(restore, REVISION));

    expect((error as ForestError).code).toBe("lease_missing");
    expect(restore).not.toHaveBeenCalled();
  });

  it("restores against the row it loaded and writes the restored text", async () => {
    const stored = row(REVISION);
    m.load.mockResolvedValue(stored);
    const restored = { contextPack: "Context: the stored value" };
    m.write.mockResolvedValue(row(LATER));
    const restore = vi.fn(async () => restored);

    await write(restore, REVISION);

    expect(restore).toHaveBeenCalledWith(stored);
    expect(m.write).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: restored,
        expectedRevision: REVISION,
      }),
    );
  });
});
