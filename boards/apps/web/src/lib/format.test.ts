import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The real helper with a stand-in for the app i18n instance: the test sets the
// interface language, as the language switcher does.
const lang = vi.hoisted(() => ({
  resolvedLanguage: "ru-RU" as string | undefined,
  language: "ru-RU",
}));
vi.mock("./i18n", () => ({ i18n: lang }));

import { formatDate, formatDateMedium, formatDateShort } from "./format";

// Local noon: the day does not move in any time zone of the test runner.
const NOV_18 = new Date(2026, 10, 18, 12, 0);

afterEach(() => {
  lang.resolvedLanguage = "ru-RU";
  lang.language = "ru-RU";
  vi.restoreAllMocks();
});

describe("date helpers (TB-225)", () => {
  it("formats short and medium dates in ru-RU", () => {
    expect(formatDateShort(NOV_18, "ru-RU")).toBe("18 нояб.");
    expect(formatDateMedium(NOV_18, "ru-RU")).toBe("18 нояб. 2026 г.");
    expect(formatDate(NOV_18, { month: "short" }, "ru-RU")).toBe("нояб.");
  });

  it("formats short and medium dates in en-US", () => {
    expect(formatDateShort(NOV_18, "en-US")).toBe("Nov 18");
    expect(formatDateMedium(NOV_18, "en-US")).toBe("Nov 18, 2026");
    expect(formatDate(NOV_18, { month: "short" }, "en-US")).toBe("Nov");
  });

  it("takes the interface language when no locale is given", () => {
    expect(formatDateShort(NOV_18)).toBe("18 нояб.");

    lang.resolvedLanguage = "en-US";
    lang.language = "en-US";
    expect(formatDateShort(NOV_18)).toBe("Nov 18");

    lang.resolvedLanguage = undefined;
    lang.language = "ru-RU";
    expect(formatDateShort(NOV_18)).toBe("18 нояб.");
  });

  it("accepts an ISO string and a timestamp", () => {
    expect(formatDateShort(NOV_18.toISOString(), "en-US")).toBe("Nov 18");
    expect(formatDateShort(NOV_18.getTime(), "en-US")).toBe("Nov 18");
  });

  it("builds one formatter per locale and options", () => {
    const spy = vi.spyOn(Intl, "DateTimeFormat");
    // A locale no other test uses, so the cache starts empty for it.
    formatDateShort(NOV_18, "de-DE");
    formatDateShort(new Date(2026, 0, 2), "de-DE");
    expect(spy).toHaveBeenCalledTimes(1);

    formatDateMedium(NOV_18, "de-DE");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(formatDateShort(NOV_18, "de-DE")).toBe("18. Nov.");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
