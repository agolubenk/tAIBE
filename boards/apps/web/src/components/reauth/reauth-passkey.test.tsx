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
import { SessionNotFreshError } from "@/lib/reauth/reauth-errors";
import { useFreshSession } from "./use-fresh-session";

// TB-31 R-6: the «key» method of the R-5 window and `confirm()`.

const m = vi.hoisted(() => ({
  passkey: vi.fn(),
  supported: vi.fn(() => true),
  result: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/lib/reauth/reauth-api", () => ({ postReauth: vi.fn() }));
vi.mock("@/lib/reauth/reauth-passkey", () => ({
  reauthWithPasskey: m.passkey,
}));
vi.mock("@/lib/passkey/passkey-client", () => ({
  supportsPasskeys: m.supported,
}));

function notFresh(methods: ReauthMethod[]) {
  return new SessionNotFreshError({
    code: "SESSION_NOT_FRESH",
    message: "",
    methods,
  });
}

function Harness({ methods }: { methods: ReauthMethod[] }) {
  const fresh = useFreshSession();
  return (
    <>
      <button
        type="button"
        onClick={() => fresh.confirm(notFresh(methods)).then(m.result)}
      >
        open
      </button>
      {fresh.dialog}
    </>
  );
}

async function open(methods: ReauthMethod[]) {
  render(<Harness methods={methods} />);
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  return screen.findByRole("dialog", { name: "auth:reauth.title" });
}

beforeEach(() => {
  m.passkey.mockReset();
  m.result.mockReset();
  m.supported.mockReturnValue(true);
});

afterEach(cleanup);

describe("the key in the R-5 window", () => {
  it("offers every other method as a link", async () => {
    const dialog = await open(["password", "passkey", "emailCode"]);
    expect(
      within(dialog).getByLabelText("auth:reauth.password.label"),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "auth:reauth.usePasskey" }),
    );
    expect(
      within(dialog).getByText("auth:reauth.passkey.explain"),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "auth:reauth.usePassword" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "auth:reauth.useCode" }),
    ).toBeTruthy();
  });

  it("asks for the key only on a press, and a confirmed key resolves confirm()", async () => {
    m.passkey.mockResolvedValue({ ok: true });
    const dialog = await open(["passkey"]);
    expect(m.passkey).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "auth:reauth.passkey.submit",
      }),
    );
    await waitFor(() => expect(m.result).toHaveBeenCalledWith(true));
    expect(m.passkey).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the system window is closed", async () => {
    m.passkey.mockResolvedValue(null);
    const dialog = await open(["passkey"]);
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "auth:reauth.passkey.submit",
      }),
    );
    await waitFor(() => expect(m.passkey).toHaveBeenCalled());
    expect(within(dialog).queryByText(/auth:reauth\.errors\./)).toBeNull();
    expect(m.result).not.toHaveBeenCalled();
  });

  it("says so when the key is another account's", async () => {
    m.passkey.mockResolvedValue({
      ok: false,
      status: 403,
      code: "REAUTH_USER_MISMATCH",
      methods: ["passkey", "emailCode"],
    });
    const dialog = await open(["passkey", "emailCode"]);
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "auth:reauth.passkey.submit",
      }),
    );
    expect(
      await within(dialog).findByText("auth:reauth.errors.userMismatch"),
    ).toBeTruthy();
    expect(m.result).not.toHaveBeenCalled();
  });

  it("drops the key in a browser without WebAuthn", async () => {
    m.supported.mockReturnValue(false);
    const dialog = await open(["passkey", "emailCode"]);
    expect(within(dialog).getByText("auth:reauth.code.send")).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "auth:reauth.usePasskey" }),
    ).toBeNull();
  });

  it("resolves confirm() with false on cancel", async () => {
    const dialog = await open(["passkey"]);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:actions.cancel" }),
    );
    await waitFor(() => expect(m.result).toHaveBeenCalledWith(false));
  });
});
