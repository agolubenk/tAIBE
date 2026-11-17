import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fetchLink = vi.hoisted(() => vi.fn());
const upsertSource = vi.hoisted(() => vi.fn());

vi.mock("./link-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./link-fetch")>()),
  fetchLink,
}));
vi.mock("./upsert-source", () => ({ upsertSource }));

import { addLinkSource } from "./link-source";
import { linkFetchesInFlight, withLinkSlot } from "./link-slots";

describe("addLinkSource and the link slots (TB-132)", () => {
  beforeEach(() => {
    fetchLink.mockReset();
    upsertSource.mockReset();
  });

  it("refuses a third link of a workspace before any fetch", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busy = [
      withLinkSlot("ws-busy", () => held),
      withLinkSlot("ws-busy", () => held),
    ];

    await expect(
      addLinkSource("ws-busy", "https://example.com/page"),
    ).rejects.toMatchObject({ status: 429, code: "LINK_BUSY" });
    expect(fetchLink).not.toHaveBeenCalled();
    expect(upsertSource).not.toHaveBeenCalled();

    release();
    await Promise.all(busy);
  });

  it("holds a slot only while the page loads", async () => {
    let inFlightDuringFetch = -1;
    fetchLink.mockImplementation(async () => {
      inFlightDuringFetch = linkFetchesInFlight("ws-free");
      return { mime: "text/plain", body: "Hello from the page." };
    });
    upsertSource.mockResolvedValue({ id: "s1" });

    await addLinkSource("ws-free", "https://example.com/page");

    expect(inFlightDuringFetch).toBe(1);
    expect(linkFetchesInFlight("ws-free")).toBe(0);
    expect(upsertSource).toHaveBeenCalledTimes(1);
  });
});
