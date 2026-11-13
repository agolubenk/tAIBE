import { describe, expect, it } from "vite-plus/test";
import { BatchLocked } from "../approval/batch-close-apply";
import {
  deferCause,
  deferredNote,
  deferredStatus,
  deferredTries,
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
});
