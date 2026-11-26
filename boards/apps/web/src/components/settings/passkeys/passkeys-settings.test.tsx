import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import type { PasskeyItem } from "@/lib/passkey/passkey-api";
import { SessionNotFreshError } from "@/lib/reauth/reauth-errors";
import { PasskeysSettings } from "./passkeys-settings";

const m = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  add: vi.fn(),
  post: vi.fn(),
  supported: vi.fn(() => true),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
}));
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/lib/format", () => ({ formatDateMedium: () => "Nov 20, 2026" }));
vi.mock("@/lib/toast", () => ({
  toast: { success: m.success, error: m.error },
}));
vi.mock("@/lib/reauth/reauth-api", () => ({ postReauth: m.post }));
vi.mock("@/lib/reauth/reauth-passkey", () => ({ reauthWithPasskey: vi.fn() }));
vi.mock("@/lib/passkey/passkey-client", () => ({
  supportsPasskeys: m.supported,
  addPasskey: m.add,
}));
vi.mock("@/lib/passkey/passkey-api", () => ({
  listPasskeys: m.list,
  removePasskey: m.remove,
  renamePasskey: m.rename,
}));

const synced: PasskeyItem = {
  id: "k1",
  name: "iCloud Keychain",
  deviceType: "multiDevice",
  createdAt: "2026-11-20T07:00:00.000Z",
};
const unnamed: PasskeyItem = {
  id: "k2",
  name: null,
  deviceType: "singleDevice",
  createdAt: "2026-11-19T07:00:00.000Z",
};

const notFresh = {
  ok: false,
  cancelled: false,
  status: 403,
  code: "SESSION_NOT_FRESH",
  methods: ["password"],
  impersonated: false,
};

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PasskeysSettings />
    </QueryClientProvider>,
  );
}

async function confirmWithPassword() {
  const dialog = await screen.findByRole("dialog", {
    name: "auth:reauth.title",
  });
  fireEvent.change(
    within(dialog).getByLabelText("auth:reauth.password.label"),
    { target: { value: "pw" } },
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "auth:reauth.password.submit" }),
  );
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.supported.mockReturnValue(true);
  m.list.mockResolvedValue([synced, unnamed]);
  m.post.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("PasskeysSettings", () => {
  it("is hidden in a browser without WebAuthn", () => {
    m.supported.mockReturnValue(false);
    show();
    expect(screen.queryByText("settings:passkeys.title")).toBeNull();
    expect(m.list).not.toHaveBeenCalled();
  });

  it("lists each key with its name, type and date", async () => {
    show();
    expect(await screen.findByText("iCloud Keychain")).toBeTruthy();
    expect(screen.getByText("settings:passkeys.unnamed")).toBeTruthy();
    expect(screen.getByText(/settings:passkeys\.multiDevice/)).toBeTruthy();
    expect(screen.getByText(/settings:passkeys\.singleDevice/)).toBeTruthy();
  });

  it("after the R-5 window waits for «Продолжить» before it creates the key", async () => {
    m.add.mockResolvedValueOnce(notFresh).mockResolvedValueOnce({ ok: true });
    show();
    await screen.findByText("iCloud Keychain");
    fireEvent.click(
      screen.getByRole("button", { name: "settings:passkeys.add" }),
    );
    await confirmWithPassword();
    const proceed = await screen.findByRole("button", {
      name: "settings:passkeys.continue",
    });
    // Safari creates a key only on a press: nothing ran after the window.
    expect(m.add).toHaveBeenCalledTimes(1);
    expect(screen.getByText("settings:passkeys.continueHint")).toBeTruthy();
    fireEvent.click(proceed);
    await waitFor(() =>
      expect(m.success).toHaveBeenCalledWith("settings:passkeys.toastAdded"),
    );
    expect(m.add).toHaveBeenCalledTimes(2);
    expect(m.list).toHaveBeenCalledTimes(2);
  });

  it("says nothing when the system window is closed", async () => {
    m.add.mockResolvedValue({
      ok: false,
      cancelled: true,
      status: 400,
      code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
    });
    show();
    await screen.findByText("iCloud Keychain");
    fireEvent.click(
      screen.getByRole("button", { name: "settings:passkeys.add" }),
    );
    await waitFor(() => expect(m.add).toHaveBeenCalled());
    expect(screen.queryByText(/auth:passkey\.errors\./)).toBeNull();
    expect(m.error).not.toHaveBeenCalled();
  });

  it("writes out why «Добавить ключ» is off at the limit", async () => {
    m.list.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ ...synced, id: `k${i}` })),
    );
    show();
    const add = await screen.findByRole("button", {
      name: "settings:passkeys.add",
    });
    await waitFor(() => expect(add.hasAttribute("disabled")).toBe(true));
    expect(screen.getByText("settings:passkeys.limit")).toBeTruthy();
  });

  it("removes a key through the R-5 window and repeats the removal", async () => {
    m.remove
      .mockRejectedValueOnce(
        new SessionNotFreshError({
          code: "SESSION_NOT_FRESH",
          message: "",
          methods: ["password"],
        }),
      )
      .mockResolvedValueOnce(undefined);
    show();
    await screen.findByText("iCloud Keychain");
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:passkeys.actions:iCloud Keychain",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "settings:passkeys.delete" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(confirm).getByRole("button", { name: "settings:passkeys.delete" }),
    );
    await confirmWithPassword();
    await waitFor(() =>
      expect(m.success).toHaveBeenCalledWith(
        "settings:passkeys.toastDeleted",
        expect.anything(),
      ),
    );
    expect(m.remove).toHaveBeenCalledTimes(2);
    expect(m.remove).toHaveBeenLastCalledWith("k1");
  });
});
