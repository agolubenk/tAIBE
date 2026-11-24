import { describe, expect, it, vi } from "vite-plus/test";
import { BatchLocked } from "../approval/batch-close-apply";
import {
  deferCause,
  deferredNote,
  deferredStatus,
  deferredTries,
  recordDeferral,
} from "./apply-deferral";
import { failText } from "./show-outcome";

describe("apply deferral (TB-114 п. 3)", () => {
  it("reads the tries back from queueSyncedStatus", () => {
    expect(deferredTries(null)).toBe(0);
    expect(deferredTries("pending")).toBe(0);
    expect(deferredTries(deferredStatus(3))).toBe(3);
  });

  it("names the cause by the error, also through drizzle's cause", () => {
    const pg = (code: string) =>
      new Error("Failed query", {
        cause: Object.assign(new Error(), { code }),
      });
    expect(deferCause(new BatchLocked())).toBe("locked");
    expect(deferCause(pg("55P03"))).toBe("lock_timeout");
    expect(deferCause(pg("57014"))).toBe("statement_timeout");
    expect(deferCause(new Error("connection refused"))).toBe("db_error");
    // The pg driver puts the code on the error itself.
    expect(deferCause(Object.assign(new Error(), { code: "55P03" }))).toBe(
      "lock_timeout",
    );
    expect(
      deferCause(Object.assign(new BatchLocked(), { code: "57014" })),
    ).toBe("locked");
  });

  it("tells the owner the cause and the try in words", () => {
    expect(deferredNote("locked", 2)).toBe(
      "Применение отложено: больше 5 карточек заняты другими записями, попытка 2 из 5.",
    );
    expect(deferredNote("unknown", 1)).toContain("ошибка базы");
    expect(failText("apply_deferred:statement_timeout")).toBe(
      "база не ответила вовремя, попыток: 5",
    );
  });

  describe("recordDeferral", () => {
    const locked = new BatchLocked();
    const writes = () => ({
      fail: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
    });

    it("saves the count, then the note, and defers", async () => {
      const w = writes();
      const order: string[] = [];
      w.save.mockImplementation(async () => void order.push("save"));
      w.note.mockImplementation(async () => void order.push("note"));
      const outcome = await recordDeferral(
        { id: "r1", synced: "deferred:1" },
        locked,
        w,
      );
      expect(outcome).toBe("deferred");
      expect(order).toEqual(["save", "note"]);
      expect(w.save).toHaveBeenCalledWith("deferred:2");
      expect(w.note).toHaveBeenCalledWith(deferredNote("locked", 2));
      expect(w.fail).not.toHaveBeenCalled();
    });

    it("fails the request on the fifth try", async () => {
      const w = writes();
      const outcome = await recordDeferral(
        { id: "r1", synced: "deferred:4" },
        locked,
        w,
      );
      expect(outcome).toBe("failed");
      expect(w.fail).toHaveBeenCalledWith("apply_deferred:locked");
      expect(w.save).not.toHaveBeenCalled();
    });

    it("still defers when markFailed fails, so the fifth try repeats after the pause", async () => {
      const w = writes();
      w.fail.mockRejectedValue(new Error("db down"));
      const log = vi.fn();
      const outcome = await recordDeferral(
        { id: "r1", synced: "deferred:4" },
        locked,
        w,
        log,
      );
      expect(outcome).toBe("deferred");
      expect(String(log.mock.calls[0]?.[0])).toContain(
        "deferred try 5 of request r1 not recorded",
      );
    });

    it("keeps the count when only the queue refuses the note", async () => {
      const w = writes();
      w.note.mockRejectedValue(new Error("queue down"));
      const outcome = await recordDeferral(
        { id: "r1", synced: null },
        locked,
        w,
        vi.fn(),
      );
      expect(outcome).toBe("deferred");
      expect(w.save).toHaveBeenCalledWith("deferred:1");
    });

    it("writes no note when the count is not saved", async () => {
      const w = writes();
      w.save.mockRejectedValue(new Error("db down"));
      const outcome = await recordDeferral(
        { id: "r1", synced: null },
        locked,
        w,
        vi.fn(),
      );
      expect(outcome).toBe("deferred");
      expect(w.note).not.toHaveBeenCalled();
    });
  });
});
