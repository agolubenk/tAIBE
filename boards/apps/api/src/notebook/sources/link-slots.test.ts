import { describe, expect, it, vi } from "vite-plus/test";
import { linkFetchesInFlight, withLinkSlot } from "./link-slots";

function pending() {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

describe("withLinkSlot (TB-132)", () => {
  it("lets two fetches of a workspace run and refuses the third at once", async () => {
    const a = pending();
    const b = pending();
    const first = withLinkSlot("ws-1", () => a.promise);
    const second = withLinkSlot("ws-1", () => b.promise);
    const third = vi.fn(async () => "never");

    await expect(withLinkSlot("ws-1", third)).rejects.toMatchObject({
      status: 429,
      code: "LINK_BUSY",
    });
    expect(third).not.toHaveBeenCalled();
    expect(linkFetchesInFlight("ws-1")).toBe(2);

    a.release();
    b.release();
    await Promise.all([first, second]);
    expect(linkFetchesInFlight("ws-1")).toBe(0);
  });

  it("counts each workspace on its own", async () => {
    const a = pending();
    const b = pending();
    const busy = [
      withLinkSlot("ws-2", () => a.promise),
      withLinkSlot("ws-2", () => b.promise),
    ];

    await expect(withLinkSlot("ws-3", async () => "ok")).resolves.toBe("ok");

    a.release();
    b.release();
    await Promise.all(busy);
  });

  it("frees the slot when the fetch fails", async () => {
    const a = pending();
    const failing = withLinkSlot("ws-4", () => a.promise);
    const held = pending();
    const holding = withLinkSlot("ws-4", () => held.promise);

    a.fail(new Error("unreachable"));
    await expect(failing).rejects.toThrow("unreachable");
    expect(linkFetchesInFlight("ws-4")).toBe(1);
    await expect(withLinkSlot("ws-4", async () => "next")).resolves.toBe(
      "next",
    );

    held.release();
    await holding;
    expect(linkFetchesInFlight("ws-4")).toBe(0);
  });
});
