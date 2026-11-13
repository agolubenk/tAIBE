import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SourceAuthor } from "./source-author";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
}));

describe("SourceAuthor (TB-115)", () => {
  it("names an agent with its session", () => {
    render(<SourceAuthor kind="agent" name="r.ai5m · Claude Code" />);
    expect(
      screen.getByText(
        "workspace:notebook.sources.addedByAgent:r.ai5m · Claude Code",
      ),
    ).toBeTruthy();
  });

  it("names a member", () => {
    render(<SourceAuthor kind="person" name="Ann" />);
    expect(
      screen.getByText("workspace:notebook.sources.addedByPerson:Ann"),
    ).toBeTruthy();
  });

  it("says unknown for a source added before authors were kept", () => {
    render(<SourceAuthor kind={null} name={null} />);
    expect(
      screen.getByText("workspace:notebook.sources.addedByUnknown"),
    ).toBeTruthy();
  });
});
