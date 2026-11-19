import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const store = vi.hoisted(() => ({ markSessionFresh: vi.fn() }));
vi.mock("./store", () => store);

const { isInteractiveSignIn, markInteractiveSession } =
  await import("./session-hook");

const session = { id: "s1", userId: "u1" };

beforeEach(() => {
  store.markSessionFresh.mockReset();
  store.markSessionFresh.mockResolvedValue(undefined);
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

  it("does not mark impersonation, a missing context or another path", async () => {
    await markInteractiveSession(
      { ...session, impersonatedBy: "admin" },
      { path: "/sign-in/email" },
    );
    await markInteractiveSession(session, null);
    await markInteractiveSession(session, { path: "/device/token" });
    expect(store.markSessionFresh).not.toHaveBeenCalled();
  });

  it("never throws: a failed mark must not fail the sign-in", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    store.markSessionFresh.mockRejectedValue(new Error("db down"));
    await expect(
      markInteractiveSession(session, { path: "/sign-in/email" }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
