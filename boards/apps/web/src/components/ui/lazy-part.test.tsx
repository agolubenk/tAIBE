import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
import { ErrorBoundary } from "./error-boundary";
import { lazyPart } from "./lazy-part";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@sentry/react", () => ({ captureReactException: vi.fn() }));

function Editor({ text }: { text: string }) {
  return <p>editor {text}</p>;
}
type EditorModule = { default: typeof Editor };

const placeholder = <div data-testid="placeholder" />;
const MISSING = "Failed to fetch dynamically imported module: /assets/x-1.js";
const reload = vi.fn();

// Mount in an async act scope, so Suspense commits the part when its import settles.
const mount = (ui: ReactNode) =>
  act(async () => {
    render(ui);
  });
const clickRetry = async () => {
  const button = await screen.findByRole("button", {
    name: "common:error.tryAgain",
  });
  await act(async () => fireEvent.click(button));
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    reload,
  });
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  reload.mockReset();
  vi.restoreAllMocks();
});

describe("lazyPart (TB-15)", () => {
  it("holds the place with the placeholder until the chunk arrives", async () => {
    let arrive!: (m: EditorModule) => void;
    const Part = lazyPart(
      () =>
        new Promise<EditorModule>((resolve) => {
          arrive = resolve;
        }),
      placeholder,
    );
    await mount(<Part text="a" />);
    expect(screen.getByTestId("placeholder")).toBeInTheDocument();
    await act(async () => arrive({ default: Editor }));
    expect(await screen.findByText("editor a")).toBeInTheDocument();
    expect(screen.queryByTestId("placeholder")).not.toBeInTheDocument();
  });

  it("reloads the page once when a deploy removed the chunk, then offers a retry instead of the crash screen", async () => {
    const load = vi
      .fn<() => Promise<EditorModule>>()
      .mockRejectedValue(new TypeError(MISSING));
    const crash = vi.fn(() => <p>crash screen</p>);
    const First = lazyPart(load, placeholder);
    await mount(
      <ErrorBoundary fallback={crash}>
        <First text="b" />
      </ErrorBoundary>,
    );
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    cleanup();

    // The same tab after that reload: the chunk is still missing, no second automatic reload.
    const Second = lazyPart(load, placeholder);
    await mount(
      <ErrorBoundary fallback={crash}>
        <Second text="b" />
      </ErrorBoundary>,
    );
    expect(
      await screen.findByText("common:error.messages.network"),
    ).toBeInTheDocument();
    expect(reload).toHaveBeenCalledOnce();
    expect(crash).not.toHaveBeenCalled();
  });

  it("imports again on the first retry", async () => {
    const load = vi
      .fn<() => Promise<EditorModule>>()
      .mockRejectedValueOnce(
        new Error("Unable to preload CSS for /assets/x.css"),
      )
      .mockResolvedValueOnce({ default: Editor });
    const Part = lazyPart(load, placeholder);
    await mount(<Part text="c" />);
    await clickRetry();
    expect(await screen.findByText("editor c")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads the page on the next retry when the import fails again", async () => {
    const load = vi
      .fn<() => Promise<EditorModule>>()
      .mockRejectedValue(new Error("network down"));
    const Part = lazyPart(load, placeholder);
    await mount(<Part text="d" />);
    await clickRetry();
    await clickRetry();
    expect(load).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("passes render errors of the loaded part on to the next boundary", async () => {
    function Broken(): never {
      throw new Error("render bug");
    }
    const Part = lazyPart(
      () => Promise.resolve({ default: Broken }),
      placeholder,
    );
    await mount(
      <ErrorBoundary fallback={({ error }) => <p>outer {error.message}</p>}>
        <Part />
      </ErrorBoundary>,
    );
    expect(await screen.findByText("outer render bug")).toBeInTheDocument();
    expect(
      screen.queryByText("common:error.messages.network"),
    ).not.toBeInTheDocument();
  });
});
