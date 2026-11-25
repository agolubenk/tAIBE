import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { PasskeyAlertPage, readAlertToken } from "./passkey-alert-page";

const m = vi.hoisted(() => ({
  inspect: vi.fn(),
  confirm: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/components/page-title", () => ({ default: () => null }));
// The footer reads the instance config; this page does not depend on it.
vi.mock("@/hooks/queries/config/use-get-config", () => ({
  default: () => ({ data: undefined }),
}));
vi.mock("@/lib/format", () => ({
  formatDateMedium: () => "Nov 20, 2026",
  formatDateTime: () => "Nov 20, 2026, 10:00",
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { $store: { notify: m.notify } },
}));
vi.mock("@/lib/passkey/passkey-api", () => ({
  inspectPasskeyAlert: m.inspect,
  confirmPasskeyAlert: m.confirm,
}));

const key = {
  keyName: "YubiKey 5",
  addedAt: "2026-11-20T07:00:00.000Z",
  keyExists: true,
};
const invalid = { ok: false, status: 400, code: "PASSKEY_ALERT_INVALID" };

function openLink(hash: string) {
  window.history.replaceState(null, "", `/account/passkey-alert${hash}`);
  render(<PasskeyAlertPage />);
}

beforeEach(() => {
  m.inspect.mockReset();
  m.confirm.mockReset();
  m.notify.mockReset();
});

afterEach(cleanup);

describe("readAlertToken", () => {
  it("reads t from the fragment", () => {
    expect(readAlertToken("#t=abc.def")).toBe("abc.def");
    expect(readAlertToken("#x=1")).toBeNull();
    expect(readAlertToken("")).toBeNull();
  });
});

describe("PasskeyAlertPage", () => {
  it("removes the token from the address bar and inspects with it", async () => {
    m.inspect.mockResolvedValue({ ok: true, data: key });
    openLink("#t=row.secret");
    expect(
      await screen.findByRole("button", { name: "auth:passkeyAlert.confirm" }),
    ).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/account/passkey-alert");
    expect(m.inspect).toHaveBeenCalledWith("row.secret");
    expect(m.confirm).not.toHaveBeenCalled();
  });

  it("removes the key on the press, then offers a password reset", async () => {
    m.inspect.mockResolvedValue({ ok: true, data: key });
    m.confirm.mockResolvedValue({ ok: true, data: { status: true } });
    openLink("#t=row.secret");
    fireEvent.click(
      await screen.findByRole("button", { name: "auth:passkeyAlert.confirm" }),
    );
    expect(await screen.findByText("auth:passkeyAlert.doneTitle")).toBeTruthy();
    expect(m.confirm).toHaveBeenCalledWith("row.secret");
    expect(m.notify).toHaveBeenCalledWith("$sessionSignal");
    expect(
      screen
        .getByRole("link", { name: "auth:passkeyAlert.resetPassword" })
        .getAttribute("href"),
    ).toBe("/auth/forgot-password");
  });

  it("offers to sign out everywhere when the key is removed already", async () => {
    m.inspect.mockResolvedValue({
      ok: true,
      data: { ...key, keyExists: false },
    });
    openLink("#t=row.secret");
    expect(
      await screen.findByRole("button", {
        name: "auth:passkeyAlert.confirmRemoved",
      }),
    ).toBeTruthy();
  });

  it("says the link does not work, and sends nothing without a token", async () => {
    openLink("");
    expect(screen.getByText("auth:passkeyAlert.invalidTitle")).toBeTruthy();
    expect(m.inspect).not.toHaveBeenCalled();
  });

  it("says the link does not work on PASSKEY_ALERT_INVALID", async () => {
    m.inspect.mockResolvedValue(invalid);
    openLink("#t=old.link");
    expect(
      await screen.findByText("auth:passkeyAlert.invalidTitle"),
    ).toBeTruthy();
  });

  it("keeps the token for a retry after 429", async () => {
    m.inspect
      .mockResolvedValueOnce({ ok: false, status: 429, code: "" })
      .mockResolvedValueOnce({ ok: true, data: key });
    openLink("#t=row.secret");
    expect(
      await screen.findByText("auth:passkeyAlert.errors.rateLimited"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "auth:passkeyAlert.retry" }),
    );
    await waitFor(() => expect(m.inspect).toHaveBeenCalledTimes(2));
    expect(m.inspect).toHaveBeenLastCalledWith("row.secret");
    expect(
      await screen.findByRole("button", { name: "auth:passkeyAlert.confirm" }),
    ).toBeTruthy();
  });
});
