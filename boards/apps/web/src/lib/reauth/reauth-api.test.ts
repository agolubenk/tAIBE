import { REAUTH_ROUTES } from "@kaneo/permissions";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { postReauth } from "./reauth-api";
import {
  isReauthFlowError,
  ReauthCancelledError,
  SessionNotFreshError,
  throwIfNotFresh,
} from "./reauth-errors";

const m = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/auth-client", () => ({ authClient: { $fetch: m.fetch } }));

type FetchOptions = {
  onError?: (context: { response: Response }) => void;
};

function replyWith(error: unknown, retryAfter?: string) {
  m.fetch.mockImplementation(async (_route: string, options: FetchOptions) => {
    if (error) {
      const headers = new Headers();
      if (retryAfter) headers.set("Retry-After", retryAfter);
      options.onError?.({ response: new Response(null, { headers }) });
    }
    return error
      ? { data: null, error }
      : { data: { status: true }, error: null };
  });
}

describe("postReauth", () => {
  beforeEach(() => {
    m.fetch.mockReset();
  });

  it("posts the body to the route of the step", async () => {
    replyWith(null);

    expect(await postReauth("password", { password: "pw" })).toEqual({
      ok: true,
    });
    expect(m.fetch).toHaveBeenCalledWith(
      REAUTH_ROUTES.password,
      expect.objectContaining({ method: "POST", body: { password: "pw" } }),
    );
  });

  it("keeps the methods of a failed reply for the window", async () => {
    replyWith({
      status: 400,
      code: "INVALID_PASSWORD",
      methods: ["emailCode"],
    });

    expect(await postReauth("password", { password: "x" })).toEqual({
      ok: false,
      status: 400,
      code: "INVALID_PASSWORD",
      methods: ["emailCode"],
      retryAfter: undefined,
    });
  });

  it("drops methods that the window does not know", async () => {
    replyWith({ status: 400, code: "INVALID_CODE", methods: ["sms"] });

    const reply = await postReauth("verifyCode", { code: "123456" });
    expect(reply.ok === false && reply.methods).toBeUndefined();
  });

  it("reads Retry-After from the response of a 429", async () => {
    replyWith({ status: 429, code: "RATE_LIMITED" }, "12");

    const reply = await postReauth("sendCode");
    expect(reply).toMatchObject({ ok: false, status: 429, retryAfter: 12 });
  });

  it("treats a thrown fetch as no answer", async () => {
    m.fetch.mockRejectedValue(new TypeError("Failed to fetch"));

    expect(await postReauth("sendCode")).toEqual({
      ok: false,
      status: 0,
      code: "",
    });
  });
});

describe("throwIfNotFresh", () => {
  it("turns the guard reply into SessionNotFreshError", () => {
    let caught: unknown;
    try {
      throwIfNotFresh({
        status: 403,
        code: "SESSION_NOT_FRESH",
        message: "",
        methods: [],
        impersonated: true,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionNotFreshError);
    expect(caught).toMatchObject({ methods: [], impersonated: true });
    expect(isReauthFlowError(caught)).toBe(true);
  });

  it("lets every other error through", () => {
    expect(() =>
      throwIfNotFresh({ status: 403, code: "SESSION_EXPIRED" }),
    ).not.toThrow();
    expect(() => throwIfNotFresh(undefined)).not.toThrow();
    expect(isReauthFlowError(new ReauthCancelledError())).toBe(true);
    expect(isReauthFlowError(new Error("x"))).toBe(false);
  });
});
