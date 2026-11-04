import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { AddSourceForm } from "./add-source-form";

const mutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/mutations/notebook/use-add-notebook-source", () => ({
  default: () => mutation,
}));

afterEach(cleanup);
beforeEach(() => {
  mutation.mutate.mockReset();
  mutation.isPending = false;
});

function field() {
  return screen.getByRole("textbox", {
    name: "workspace:notebook.sources.add.label",
  });
}

const submit = () =>
  screen.getByRole("button", { name: /workspace:notebook.sources.add.submit/ });

describe("AddSourceForm", () => {
  it("sends a GitHub PR link to the PR route and any other link as a page", () => {
    render(<AddSourceForm workspaceId="ws-1" />);
    expect(submit()).toHaveProperty("disabled", true);

    fireEvent.change(field(), {
      target: { value: " https://github.com/example/repo/pull/7/files " },
    });
    fireEvent.click(submit());
    expect(mutation.mutate).toHaveBeenLastCalledWith(
      {
        kind: "github-pr",
        url: "https://github.com/example/repo/pull/7/files",
      },
      expect.anything(),
    );

    fireEvent.change(field(), {
      target: { value: "https://docs.example.com/lease" },
    });
    fireEvent.click(submit());
    expect(mutation.mutate).toHaveBeenLastCalledWith(
      { kind: "link", url: "https://docs.example.com/lease" },
      expect.anything(),
    );
  });

  it("clears the field once the source is stored", () => {
    mutation.mutate.mockImplementation(
      (_input: unknown, options: { onSuccess: () => void }) =>
        options.onSuccess(),
    );
    render(<AddSourceForm workspaceId="ws-1" />);

    fireEvent.change(field(), { target: { value: "example/repo#7" } });
    fireEvent.click(submit());

    expect(mutation.mutate.mock.calls[0]?.[0]).toEqual({
      kind: "github-pr",
      url: "example/repo#7",
    });
    expect(field()).toHaveProperty("value", "");
  });

  it("does not send twice while a fetch is running", () => {
    mutation.isPending = true;
    render(<AddSourceForm workspaceId="ws-1" />);

    fireEvent.change(field(), { target: { value: "https://example.com" } });
    fireEvent.submit(field().closest("form") as HTMLFormElement);

    expect(submit()).toHaveProperty("disabled", true);
    expect(mutation.mutate).not.toHaveBeenCalled();
  });
});
