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
import { DeleteAccountSection } from "./delete-account-section";

const m = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
  navigate: vi.fn(),
  clear: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  post: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => m.navigate,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ clear: m.clear }),
}));
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/lib/reauth/reauth-api", () => ({ postReauth: m.post }));
vi.mock("@/hooks/mutations/use-delete-account", () => ({
  default: () => ({ mutateAsync: m.deleteAccount, isPending: false }),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: m.success, error: m.error },
}));

function openDialog() {
  fireEvent.click(
    screen.getByRole("button", {
      name: "settings:informationPage.deleteAccount.title",
    }),
  );
}

function confirmButton() {
  return screen.findByRole("button", {
    name: "settings:informationPage.deleteAccount.confirm",
  });
}

describe("DeleteAccountSection", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    m.deleteAccount.mockResolvedValue(undefined);
    m.post.mockResolvedValue({ ok: true });
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
  });

  it("keeps the confirm disabled until the email is typed", async () => {
    render(<DeleteAccountSection email="jo@example.com" />);
    openDialog();

    expect(await confirmButton()).toBeDisabled();

    fireEvent.change(
      screen.getByLabelText(
        "settings:informationPage.deleteAccount.confirmLabel",
      ),
      { target: { value: "JO@example.com" } },
    );

    expect(await confirmButton()).toBeEnabled();
    fireEvent.click(await confirmButton());

    await waitFor(() => expect(m.deleteAccount).toHaveBeenCalled());
    expect(m.clear).toHaveBeenCalled();
    expect(m.navigate).toHaveBeenCalledWith({ to: "/auth/sign-in" });
  });

  it("asks to confirm it is you and then deletes, without a toast", async () => {
    m.deleteAccount
      .mockRejectedValueOnce(
        new SessionNotFreshError({
          code: "SESSION_NOT_FRESH",
          message: "",
          methods: ["password"],
        }),
      )
      .mockResolvedValueOnce(undefined);
    render(<DeleteAccountSection email="jo@example.com" />);
    openDialog();

    fireEvent.change(
      screen.getByLabelText(
        "settings:informationPage.deleteAccount.confirmLabel",
      ),
      { target: { value: "jo@example.com" } },
    );
    fireEvent.click(await confirmButton());

    const dialog = await screen.findByRole("dialog", {
      name: "auth:reauth.title",
    });
    expect(m.navigate).not.toHaveBeenCalled();
    fireEvent.change(
      within(dialog).getByLabelText("auth:reauth.password.label"),
      {
        target: { value: "pw" },
      },
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "auth:reauth.password.submit",
      }),
    );

    await waitFor(() =>
      expect(m.navigate).toHaveBeenCalledWith({ to: "/auth/sign-in" }),
    );
    expect(m.deleteAccount).toHaveBeenCalledTimes(2);
    expect(m.error).not.toHaveBeenCalled();
  });
});
