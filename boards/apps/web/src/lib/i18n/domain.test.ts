import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("i18next", () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) =>
      key.startsWith("tasks:severity.") || key.startsWith("tasks:priority.")
        ? `[${key}]`
        : (options?.defaultValue ?? key),
  },
}));

import { getPriorityLabel, getSeverityLabel, getStatusLabel } from "./domain";

describe("domain labels (TB-220)", () => {
  it("gives a known severity its label, in any case and with spaces", () => {
    expect(getSeverityLabel("high")).toBe("[tasks:severity.high]");
    expect(getSeverityLabel(" High ")).toBe("[tasks:severity.high]");
    expect(getSeverityLabel("CRITICAL")).toBe("[tasks:severity.critical]");
  });

  it("shows free-text severity as written", () => {
    expect(getSeverityLabel("Критичная")).toBe("Критичная");
    expect(getSeverityLabel("major")).toBe("major");
    // A dot would read as a nested i18n key; it never reaches i18n.
    expect(getSeverityLabel("p0.blocker")).toBe("p0.blocker");
  });

  it("labels priority by key and falls back to display case for status", () => {
    expect(getPriorityLabel("urgent")).toBe("[tasks:priority.urgent]");
    expect(getStatusLabel("qa-check")).toBe("Qa Check");
  });
});
