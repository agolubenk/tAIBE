import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const store = vi.hoisted(() => ({ markSessionFresh: vi.fn() }));
const device = vi.hoisted(() => ({ markDeviceSession: vi.fn() }));
vi.mock("./store", () => store);
vi.mock("./device-session", () => device);

const { isInteractiveSignIn, markInteractiveSession } =
  await import("./session-hook");

const session = { id: "s1", userId: "u1" };

beforeEach(() => {
  store.markSessionFresh.mockReset();
  store.markSessionFresh.mockResolvedValue(undefined);
  device.markDeviceSession.mockReset();
  device.markDeviceSession.mockResolvedValue(undefined);
});

describe("TB-31 R-5: the mark on a new session", () => {
  it.each([
    ["/sign-in/email", true],
    ["/sign-in/username", true],
    ["/sign-in/email-otp", true],
    ["/magic-link/verify", true],
    ["/passkey/verify-authentication", true],
    ["/callback/:id", true],
    ["/oauth2/callback/:providerId", true],
    ["/sign-up/email", false],
    ["/device/token", false],
    ["/admin/impersonate-user", false],
    ["/sign-in/anonymous", false],
    ["/sign-in/email-otp/extra", false],
    ["/callback", false],
    [undefined, false],
  ])("%s interactive: %s", (path, want) => {
    expect(isInteractiveSignIn(path)).toBe(want);
  });

  it("marks a session made by an interactive sign-in", async () => {
    await markInteractiveSession(session, { path: "/sign-in/email" });
    expect(store.markSessionFresh).toHaveBeenCalledWith("s1", "u1");
  });

  it("marks a device-flow session as a device session, not as fresh", async () => {
    await markInteractiveSession(session, { path: "/device/token" });
    expect(device.markDeviceSession).toHaveBeenCalledWith("s1", "u1");
    expect(store.markSessionFresh).not.toHaveBeenCalled();
  });

  it("does not mark impersonation, a missing context or another path", async () => {
    for (const path of ["/sign-in/email", "/device/token"]) {
      await markInteractiveSession(
        { ...session, impersonatedBy: "admin" },
        { path },
      );
    }
    await markInteractiveSession(session, null);
    await markInteractiveSession(session, { path: "/sign-up/email" });
    expect(store.markSessionFresh).not.toHaveBeenCalled();
    expect(device.markDeviceSession).not.toHaveBeenCalled();
  });

  it("never throws: a failed mark must not fail the sign-in", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    store.markSessionFresh.mockRejectedValue(new Error("db down"));
    device.markDeviceSession.mockRejectedValue(new Error("db down"));
    for (const path of ["/sign-in/email", "/device/token"]) {
      await expect(
        markInteractiveSession(session, { path }),
      ).resolves.toBeUndefined();
    }
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
