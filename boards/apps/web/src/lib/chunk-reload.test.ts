import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { handleCssPreloadError, reloadOnce } from "./chunk-reload";

const CSS_MISSING =
  "Unable to preload CSS for /assets/task-details-content-1.css";
const SCRIPT_MISSING =
  "Failed to fetch dynamically imported module: /assets/x-1.js";
const reload = vi.fn();

function preloadError(payload: unknown) {
  const event = new Event("vite:preloadError", { cancelable: true });
  return Object.assign(event, { payload });
}

beforeEach(() => {
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    reload,
  });
});

afterEach(() => {
  sessionStorage.clear();
  reload.mockReset();
  vi.restoreAllMocks();
});

describe("reloadOnce", () => {
  it("reloads once per missing chunk, then leaves the error to the caller", () => {
    expect(reloadOnce(new Error(CSS_MISSING))).toBe(true);
    expect(reloadOnce(new Error(CSS_MISSING))).toBe(false);
    expect(reloadOnce(new TypeError(SCRIPT_MISSING))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload for other errors", () => {
    expect(reloadOnce(new Error("network down"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload when storage is off, so no reload loop", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(reloadOnce(new Error(CSS_MISSING))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("vite:preloadError for missing CSS (TB-127)", () => {
  it("reloads the page once and stops Vite rethrowing", () => {
    const event = preloadError(new Error(CSS_MISSING));
    handleCssPreloadError(event);
    expect(reload).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets the same error after that reload go on to the error screen", () => {
    handleCssPreloadError(preloadError(new Error(CSS_MISSING)));
    const again = preloadError(new Error(CSS_MISSING));
    handleCssPreloadError(again);
    expect(reload).toHaveBeenCalledOnce();
    expect(again.defaultPrevented).toBe(false);
  });

  it("leaves a missing script to the router and lazyPart", () => {
    const event = preloadError(new TypeError(SCRIPT_MISSING));
    handleCssPreloadError(event);
    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });

  it("ignores an event without an Error payload", () => {
    const event = preloadError("Unable to preload CSS for /assets/x.css");
    handleCssPreloadError(event);
    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
