import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { PasskeySignInButton } from "./passkey-sign-in-button";

const m = vi.hoisted(() => ({
  signIn: vi.fn(),
  supported: vi.fn(() => true),
  success: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/passkey/passkey-client", () => ({
  signInWithPasskey: m.signIn,
  supportsPasskeys: m.supported,
}));

function press() {
  render(<PasskeySignInButton onSuccess={m.success} />);
  fireEvent.click(screen.getByRole("button", { name: "auth:passkey.signIn" }));
}

beforeEach(() => {
  m.signIn.mockReset();
  m.success.mockReset();
  m.supported.mockReturnValue(true);
});

afterEach(cleanup);

describe("PasskeySignInButton", () => {
  it("is not shown in a browser without WebAuthn", () => {
    m.supported.mockReturnValue(false);
    render(<PasskeySignInButton onSuccess={m.success} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("signs in on the press", async () => {
    m.signIn.mockResolvedValue({ ok: true });
    press();
    await waitFor(() => expect(m.success).toHaveBeenCalledTimes(1));
  });

  it("says nothing when the system window is closed", async () => {
    m.signIn.mockResolvedValue({
      ok: false,
      cancelled: true,
      status: 400,
      code: "AUTH_CANCELLED",
    });
    press();
    await waitFor(() => expect(m.signIn).toHaveBeenCalled());
    expect(screen.queryByText(/auth:passkey\.errors\./)).toBeNull();
    expect(m.success).not.toHaveBeenCalled();
  });

  it("asks for a key with a PIN or biometrics", async () => {
    m.signIn.mockResolvedValue({
      ok: false,
      cancelled: false,
      status: 401,
      code: "USER_VERIFICATION_REQUIRED",
    });
    press();
    const message = await screen.findByText(
      "auth:passkey.errors.userVerificationRequired",
    );
    const button = screen.getByRole("button", { name: "auth:passkey.signIn" });
    expect(button.getAttribute("aria-describedby")).toBe(message.id);
  });
});
