import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { closeTab } from "@/test/close-tab";
import { useWarnBeforeUnload } from "./use-warn-before-unload";

afterEach(cleanup);

describe("useWarnBeforeUnload (TB-236)", () => {
  it("asks before closing the tab only while active", () => {
    const { rerender } = renderHook(
      ({ active }) => useWarnBeforeUnload(active),
      { initialProps: { active: false } },
    );
    expect(closeTab()).toBe(false);
    rerender({ active: true });
    expect(closeTab()).toBe(true);
    rerender({ active: false });
    expect(closeTab()).toBe(false);
  });

  it("stops asking once unmounted", () => {
    const { unmount } = renderHook(() => useWarnBeforeUnload(true));
    expect(closeTab()).toBe(true);
    unmount();
    expect(closeTab()).toBe(false);
  });

  it("keeps one user's warning when another user stops", () => {
    const first = renderHook(({ active }) => useWarnBeforeUnload(active), {
      initialProps: { active: true },
    });
    const second = renderHook(() => useWarnBeforeUnload(true));
    first.rerender({ active: false });
    expect(closeTab()).toBe(true);
    second.unmount();
    expect(closeTab()).toBe(false);
  });
});
