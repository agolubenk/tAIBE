import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const m = vi.hoisted(() => ({
  load: vi.fn(),
  signIn: vi.fn(),
  add: vi.fn(),
  getActions: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { $fetch: "main-fetch", $store: "main-store" },
}));
vi.mock("@better-auth/passkey/client", () => {
  m.load();
  return {
    passkeyClient: () => ({ getActions: m.getActions }),
  };
});

import {
  addPasskey,
  passkeyReply,
  signInWithPasskey,
  supportsPasskeys,
} from "./passkey-client";

beforeEach(() => {
  m.signIn.mockReset();
  m.add.mockReset();
  m.getActions.mockReset();
  m.getActions.mockReturnValue({
    signIn: { passkey: m.signIn },
    passkey: { addPasskey: m.add },
  });
});

describe("passkeyReply", () => {
  it("is ok without an error", () => {
    expect(passkeyReply(null)).toEqual({ ok: true });
  });

  it.each([
    "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
    "ERROR_CEREMONY_ABORTED",
    "AUTH_CANCELLED",
  ])("treats %s as a closed system window", (code) => {
    expect(passkeyReply({ status: 400, code })).toMatchObject({
      ok: false,
      cancelled: true,
    });
  });

  it("keeps the methods of a refusal and drops unknown ones", () => {
    expect(
      passkeyReply({
        status: 403,
        code: "SESSION_NOT_FRESH",
        methods: ["password", "passkey"],
      }),
    ).toEqual({
      ok: false,
      cancelled: false,
      status: 403,
      code: "SESSION_NOT_FRESH",
      methods: ["password", "passkey"],
      impersonated: false,
    });
    expect(
      passkeyReply({ status: 403, code: "X", methods: ["sms"] }),
    ).toMatchObject({ methods: undefined });
  });
});

describe("ceremonies", () => {
  it("run on the main client's fetch and store, loaded on the first call", async () => {
    m.signIn.mockResolvedValue({ data: {}, error: null });
    expect(m.load).not.toHaveBeenCalled();
    await expect(signInWithPasskey()).resolves.toEqual({ ok: true });
    expect(m.getActions).toHaveBeenCalledWith("main-fetch", "main-store");
    m.add.mockResolvedValue({
      data: null,
      error: { status: 400, code: "PASSKEY_LIMIT_REACHED" },
    });
    await expect(addPasskey()).resolves.toMatchObject({
      ok: false,
      cancelled: false,
      code: "PASSKEY_LIMIT_REACHED",
    });
    expect(m.load).toHaveBeenCalledTimes(1);
  });

  it("answers status 0 when the ceremony throws", async () => {
    m.signIn.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(signInWithPasskey()).resolves.toEqual({
      ok: false,
      cancelled: false,
      status: 0,
      code: "",
    });
  });
});

describe("supportsPasskeys", () => {
  it("follows window.PublicKeyCredential", () => {
    expect(supportsPasskeys()).toBe(false);
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    expect(supportsPasskeys()).toBe(true);
    vi.unstubAllGlobals();
  });
});
