import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const m = vi.hoisted(() => ({
  email: vi.fn(),
  username: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { email: m.email, username: m.username } },
}));

const { signInMessage, signInWithPassword } =
  await import("./password-sign-in");

beforeEach(() => {
  vi.clearAllMocks();
  m.email.mockResolvedValue({ data: {}, error: null });
  m.username.mockResolvedValue({ data: {}, error: null });
});

describe("signInWithPassword (TB-31 R-1)", () => {
  it("sends a value with @ and the admin alias to /sign-in/email", async () => {
    await signInWithPassword(" ivan@example.com ", "pw");
    await signInWithPassword("admin", "pw");
    expect(m.email.mock.calls.map(([body]) => body.email)).toEqual([
      "ivan@example.com",
      "admin@t-boards.local",
    ]);
    expect(m.username).not.toHaveBeenCalled();
  });

  it("sends a login to /sign-in/username trimmed, case kept", async () => {
    const result = await signInWithPassword(" IVAN42 ", "pw", {
      "x-turnstile-token": "t",
    });
    expect(result).toEqual({ ok: true });
    expect(m.username).toHaveBeenCalledWith(
      { username: "IVAN42", password: "pw" },
      expect.objectContaining({ headers: { "x-turnstile-token": "t" } }),
    );
  });

  it("reads Retry-After of a 429", async () => {
    m.username.mockImplementation(async (_body, options) => {
      options.onError({
        response: new Response(null, {
          status: 429,
          headers: { "Retry-After": "41" },
        }),
      });
      return { data: null, error: { status: 429, message: "Too many" } };
    });
    expect(await signInWithPassword("ivan42", "pw")).toMatchObject({
      ok: false,
      status: 429,
      retryAfter: 41,
    });
  });

  it("calls a thrown request offline", async () => {
    m.username.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await signInWithPassword("ivan42", "pw")).toMatchObject({
      ok: false,
      status: 0,
    });
  });
});

describe("signInMessage (TB-31 R-1, AC-3, AC-13)", () => {
  const failure = { status: 400, code: "", message: "" };

  it("gives one phrase for a wrong login and a wrong password", () => {
    for (const code of [
      "INVALID_EMAIL_OR_PASSWORD",
      "INVALID_USERNAME_OR_PASSWORD",
    ]) {
      expect(signInMessage({ ...failure, status: 401, code })).toEqual({
        key: "auth:signInForm.invalidCredentials",
      });
    }
    expect(
      signInMessage({ ...failure, status: 422, code: "USERNAME_TOO_SHORT" }),
    ).toEqual({ key: "auth:signInForm.invalidCredentials" });
  });

  it("does not call 429 a wrong password", () => {
    expect(signInMessage({ ...failure, status: 429, retryAfter: 41 })).toEqual({
      key: "auth:signInForm.rateLimitedFor",
      values: { seconds: 41 },
    });
    expect(signInMessage({ ...failure, status: 429 })).toEqual({
      key: "auth:signInForm.rateLimited",
    });
  });

  it("says there is no connection", () => {
    expect(signInMessage({ ...failure, status: 0 })).toEqual({
      key: "auth:signInForm.offline",
    });
  });

  it("keeps the server's text for other refusals", () => {
    expect(
      signInMessage({
        status: 403,
        code: "EMAIL_NOT_VERIFIED",
        message: "Email not verified",
      }),
    ).toEqual({ text: "Email not verified" });
    expect(signInMessage({ ...failure, status: 500 })).toEqual({
      key: "auth:signInForm.failedSignIn",
    });
  });
});
