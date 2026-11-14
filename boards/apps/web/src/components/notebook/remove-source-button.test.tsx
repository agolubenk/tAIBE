import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { RemoveSourceButton } from "./remove-source-button";

const mutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/mutations/notebook/use-remove-notebook-source", () => ({
  default: () => mutation,
}));

afterEach(cleanup);
beforeEach(() => {
  mutation.mutate.mockReset();
  mutation.isPending = false;
});

describe("RemoveSourceButton (TB-132)", () => {
  it("asks first and removes the source only after the confirmation", () => {
    render(
      <RemoveSourceButton
        workspaceId="ws-1"
        kind="github-pr"
        ref_="example/repo#7"
        title="Fix the lease"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "workspace:notebook.sources.remove" }),
    );
    expect(mutation.mutate).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "workspace:notebook.sources.removeConfirm",
      }),
    );
    expect(mutation.mutate).toHaveBeenCalledWith(
      { kind: "github-pr", ref: "example/repo#7", title: "Fix the lease" },
      expect.anything(),
    );
  });
});
