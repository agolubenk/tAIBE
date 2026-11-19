import type { ReauthMethod } from "@kaneo/permissions";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  ReauthCancelledError,
  SessionNotFreshError,
} from "@/lib/reauth/reauth-errors";
import { useFreshSession } from "./use-fresh-session";

const m = vi.hoisted(() => ({ post: vi.fn(), result: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/lib/reauth/reauth-api", () => ({ postReauth: m.post }));

function notFresh(methods: ReauthMethod[], impersonated = false) {
  return new SessionNotFreshError({
    code: "SESSION_NOT_FRESH",
    message: "",
    methods,
    ...(impersonated ? { impersonated: true as const } : {}),
  });
}

function Harness({ action }: { action: () => Promise<string> }) {
  const freshSession = useFreshSession();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          freshSession.run(action).then(
            (value) => m.result({ value }),
            (error: unknown) => m.result({ error }),
          )
        }
      >
        run
      </button>
      {freshSession.dialog}
    </>
  );
}

function start(action: () => Promise<string>) {
  render(<Harness action={action} />);
  fireEvent.click(screen.getByRole("button", { name: "run" }));
}

function reauthWindow() {
  return screen.findByRole("dialog", { name: "auth:reauth.title" });
}

async function confirmWithPassword(password = "pw") {
  const dialog = await reauthWindow();
  fireEvent.change(
    within(dialog).getByLabelText("auth:reauth.password.label"),
    {
      target: { value: password },
    },
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "auth:reauth.password.submit" }),
  );
}

function lastResult() {
  return m.result.mock.calls.at(-1)?.[0] as
    | { value?: string; error?: unknown }
    | undefined;
}

describe("useFreshSession", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    m.post.mockResolvedValue({ ok: true });
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
  });

  it("returns the result without a window when the session is fresh", async () => {
    start(async () => "key");

    await waitFor(() => expect(lastResult()).toEqual({ value: "key" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("repeats the action once after the person confirms", async () => {
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(notFresh(["password", "emailCode"]))
      .mockResolvedValueOnce("key");
    start(action);

    await confirmWithPassword("secret");

    await waitFor(() => expect(lastResult()).toEqual({ value: "key" }));
    expect(m.post).toHaveBeenCalledWith("password", { password: "secret" });
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("throws ReauthCancelledError and does not repeat after cancel", async () => {
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(notFresh(["password"]));
    start(action);

    const dialog = await reauthWindow();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:actions.cancel" }),
    );

    await waitFor(() =>
      expect(lastResult()?.error).toBeInstanceOf(ReauthCancelledError),
    );
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("does not ask twice when the repeat is refused again", async () => {
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(notFresh(["password"]));
    start(action);

    await confirmWithPassword();

    await waitFor(() =>
      expect(lastResult()?.error).toEqual(
        new Error("auth:reauth.errors.stillNotFresh"),
      ),
    );
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("shows only the methods from the server", async () => {
    start(() => Promise.reject(notFresh(["emailCode"])));

    const dialog = await reauthWindow();
    expect(
      within(dialog).queryByLabelText("auth:reauth.password.label"),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "auth:reauth.code.send" }),
    ).toBeTruthy();
    expect(within(dialog).queryByText("auth:reauth.usePassword")).toBeNull();
    // AC-17: nothing is sent until the person asks for the code.
    expect(m.post).not.toHaveBeenCalled();
  });

  it("redraws from the methods of a failed reply", async () => {
    m.post.mockResolvedValue({
      ok: false,
      status: 400,
      code: "INVALID_PASSWORD",
      methods: ["emailCode"],
    });
    start(() => Promise.reject(notFresh(["password", "emailCode"])));

    await confirmWithPassword("wrong");

    const dialog = await reauthWindow();
    await within(dialog).findByText("auth:reauth.lockedOut");
    expect(
      within(dialog).queryByLabelText("auth:reauth.password.label"),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "auth:reauth.code.send" }),
    ).toBeTruthy();
  });

  it("explains a missing method and impersonation", async () => {
    start(() => Promise.reject(notFresh([], true)));
    expect(
      await within(await reauthWindow()).findByText("auth:reauth.impersonated"),
    ).toBeTruthy();
    cleanup();

    start(() => Promise.reject(notFresh([])));
    expect(
      await within(await reauthWindow()).findByText("auth:reauth.noMethod"),
    ).toBeTruthy();
  });

  it("confirms with the code, not with the sent code", async () => {
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(notFresh(["emailCode"]))
      .mockResolvedValueOnce("key");
    start(action);
    const dialog = await reauthWindow();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "auth:reauth.code.send" }),
    );
    const input = await within(dialog).findByLabelText(
      "auth:reauth.code.label",
    );
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "auth:reauth.title" })).toBe(
      dialog,
    );

    fireEvent.change(input, { target: { value: "654321" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "auth:reauth.code.submit" }),
    );

    await waitFor(() => expect(lastResult()).toEqual({ value: "key" }));
    expect(m.post).toHaveBeenLastCalledWith("verifyCode", { code: "654321" });
  });

  it("clears an expired code and keeps a wrong one", async () => {
    start(() => Promise.reject(notFresh(["emailCode"])));
    const dialog = await reauthWindow();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "auth:reauth.code.send" }),
    );
    const input = (await within(dialog).findByLabelText(
      "auth:reauth.code.label",
    )) as HTMLInputElement;
    expect(m.post).toHaveBeenCalledWith("sendCode");

    fireEvent.change(input, { target: { value: "12a3456" } });
    expect(input.value).toBe("123456");

    m.post.mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: "INVALID_CODE",
      methods: ["emailCode"],
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "auth:reauth.code.submit" }),
    );
    await within(dialog).findByText("auth:reauth.errors.invalidCode");
    expect(input.value).toBe("123456");

    m.post.mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: "CODE_EXPIRED",
      methods: ["emailCode"],
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "auth:reauth.code.submit" }),
    );
    await within(dialog).findByText("auth:reauth.errors.codeExpired");
    expect(input.value).toBe("");
  });

  it("shows the wait on 429", async () => {
    m.post.mockResolvedValue({
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      retryAfter: 30,
    });
    start(() => Promise.reject(notFresh(["emailCode"])));
    const dialog = await reauthWindow();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "auth:reauth.code.send" }),
    );

    expect(
      await within(dialog).findByText("auth:reauth.errors.rateLimitedFor"),
    ).toBeTruthy();
  });
});
