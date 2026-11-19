import {
  act,
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

const m = vi.hoisted(() => ({
  isUsernameAvailable: vi.fn(),
  updateUser: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: m }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { seconds?: number }) =>
      values?.seconds ? `${key}:${values.seconds}` : key,
  }),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const fresh = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/components/reauth/use-fresh-session", () => ({
  useFreshSession: () => ({ run: fresh.run, dialog: null }),
}));

const { LoginRow } = await import("./login-row");
const { ReauthCancelledError } = await import("@/lib/reauth/reauth-errors");

const P = "settings:informationPage.login";
const refetchUser = vi.fn(async () => undefined);

function field() {
  return screen.getByLabelText(`${P}.label`);
}
function saveButton() {
  return screen.getByRole("button", { name: `${P}.save` });
}
function type(value: string) {
  fireEvent.change(field(), { target: { value } });
}
// The hint or the problem under the field: one live region from the start.
function note() {
  return screen.getByRole("status");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const TAKEN = { data: { available: false }, error: null };
// Lets every pending answer reach the component before the assertion.
async function flush() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.isUsernameAvailable.mockResolvedValue({
    data: { available: true },
    error: null,
  });
  m.updateUser.mockResolvedValue({ data: {}, error: null });
  fresh.run.mockImplementation((action: () => Promise<unknown>) => action());
});
afterEach(cleanup);

describe("LoginRow (TB-31 R-1)", () => {
  it("asks a person without a login to set one", () => {
    render(<LoginRow current={null} refetchUser={refetchUser} />);
    expect(screen.getByText(`${P}.emptyHint`)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it("refuses the rule and reserved names in the browser, no request (AC-2)", () => {
    render(<LoginRow current={null} refetchUser={refetchUser} />);
    for (const [value, problem] of [
      ["admin", "reserved"],
      ["ab", "tooShort"],
      ["иван", "invalid"],
      ["ivan.k", "invalid"],
      ["a".repeat(31), "tooLong"],
    ] as const) {
      type(value);
      fireEvent.blur(field());
      expect(note()).toHaveTextContent(
        `${P}.problems.${problem}`,
      );
      expect(field()).toHaveAttribute("aria-invalid", "true");
      expect(saveButton()).toBeDisabled();
    }
    expect(m.isUsernameAvailable).not.toHaveBeenCalled();
  });

  it("checks a taken login once, on leaving the field (AC-2)", async () => {
    m.isUsernameAvailable.mockResolvedValue({
      data: { available: false },
      error: null,
    });
    render(<LoginRow current={null} refetchUser={refetchUser} />);
    type("ivan4");
    type("ivan42");
    expect(m.isUsernameAvailable).not.toHaveBeenCalled();
    fireEvent.blur(field());
    await waitFor(() =>
      expect(note()).toHaveTextContent(
        `${P}.problems.taken`,
      ),
    );
    expect(m.isUsernameAvailable).toHaveBeenCalledTimes(1);
    expect(m.isUsernameAvailable).toHaveBeenCalledWith(
      { username: "ivan42" },
      expect.anything(),
    );
    expect(saveButton()).toBeDisabled();
  });

  it("says 429 with the wait, not «taken»", async () => {
    m.isUsernameAvailable.mockImplementation(async (_body, options) => {
      options.onError({
        response: new Response(null, {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      });
      return { data: null, error: { status: 429 } };
    });
    render(<LoginRow current={null} refetchUser={refetchUser} />);
    type("ivan42");
    fireEvent.blur(field());
    await waitFor(() =>
      expect(note()).toHaveTextContent(
        `${P}.problems.rateLimitedFor:30`,
      ),
    );
  });

  it("does not ask about the person's own login in another case", () => {
    render(<LoginRow current="ivan42" refetchUser={refetchUser} />);
    type("Ivan42");
    fireEvent.blur(field());
    expect(m.isUsernameAvailable).not.toHaveBeenCalled();
    expect(saveButton()).toBeEnabled();
  });

  it("saves the pair through the fresh sign-in window", async () => {
    render(<LoginRow current="ivan42" refetchUser={refetchUser} />);
    expect(screen.getByText(`${P}.saveHint`)).toBeInTheDocument();
    type("Ivan43");
    fireEvent.click(saveButton());
    await waitFor(() => expect(refetchUser).toHaveBeenCalled());
    expect(fresh.run).toHaveBeenCalledTimes(1);
    expect(m.updateUser).toHaveBeenCalledWith(
      { username: "Ivan43", displayUsername: "Ivan43" },
      expect.anything(),
    );
  });

  it("shows «taken» from the save and nothing when the window is closed", async () => {
    m.updateUser.mockResolvedValue({
      data: null,
      error: { status: 400, code: "USERNAME_IS_ALREADY_TAKEN" },
    });
    render(<LoginRow current={null} refetchUser={refetchUser} />);
    type("ivan42");
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(note()).toHaveTextContent(
        `${P}.problems.taken`,
      ),
    );

    fresh.run.mockRejectedValue(new ReauthCancelledError());
    type("ivan43");
    fireEvent.click(saveButton());
    await waitFor(() => expect(fresh.run).toHaveBeenCalledTimes(2));
    expect(note()).not.toHaveTextContent(`${P}.problems.`);
    expect(refetchUser).not.toHaveBeenCalled();
  });

  it("says «too short» after the person leaves the field, not on the first letter", () => {
    render(<LoginRow current={null} refetchUser={refetchUser} />);
    type("i");
    expect(note()).toHaveTextContent(`${P}.emptyHint`);
    expect(saveButton()).toBeDisabled();
    fireEvent.blur(field());
    expect(note()).toHaveTextContent(`${P}.problems.tooShort`);
    expect(m.isUsernameAvailable).not.toHaveBeenCalled();
  });

  it("drops a check answer for a value the person has changed since (B3)", async () => {
    const answer = deferred<typeof TAKEN>();
    m.isUsernameAvailable.mockReturnValue(answer.promise);
    render(<LoginRow current={null} refetchUser={refetchUser} />);
    type("ivan42");
    fireEvent.blur(field());
    type("ivan43");
    answer.resolve(TAKEN);
    await flush();
    await waitFor(() => expect(m.isUsernameAvailable).toHaveBeenCalledTimes(1));
    expect(note()).not.toHaveTextContent(`${P}.problems.taken`);
    expect(saveButton()).toBeEnabled();
  });

  it("drops a check answer that comes after the save (B3)", async () => {
    const answer = deferred<typeof TAKEN>();
    m.isUsernameAvailable.mockReturnValue(answer.promise);
    render(<LoginRow current={null} refetchUser={refetchUser} />);
    type("ivan42");
    fireEvent.blur(field());
    fireEvent.click(saveButton());
    await waitFor(() => expect(refetchUser).toHaveBeenCalled());
    answer.resolve(TAKEN);
    await flush();
    expect(note()).not.toHaveTextContent(`${P}.problems.taken`);
  });

  it("keeps «Save» on after 429 or a lost connection from the check (N1)", async () => {
    m.isUsernameAvailable.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<LoginRow current={null} refetchUser={refetchUser} />);
    type("ivan42");
    fireEvent.blur(field());
    await waitFor(() =>
      expect(note()).toHaveTextContent(`${P}.problems.offline`),
    );
    expect(saveButton()).toBeEnabled();
  });

  it("does not check on leaving the field for «Save»: one request (N3)", async () => {
    render(<LoginRow current={null} refetchUser={refetchUser} />);
    type("ivan42");
    fireEvent.blur(field(), { relatedTarget: saveButton() });
    fireEvent.click(saveButton());
    await waitFor(() => expect(refetchUser).toHaveBeenCalled());
    expect(m.isUsernameAvailable).not.toHaveBeenCalled();
    expect(m.updateUser).toHaveBeenCalledTimes(1);
  });
});
