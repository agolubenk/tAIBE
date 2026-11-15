import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { HttpError } from "@/lib/http-error";
import { taskForm } from "./form-test-template";
import { TaskFormBlock } from "./task-form-block";
import { TaskFormsSlot } from "./task-forms-slot";

const { getForms, save } = vi.hoisted(() => ({
  getForms: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@/fetchers/task-form/get-task-forms", () => ({ default: getForms }));
vi.mock("@/fetchers/task-form/save-task-form-answers", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  default: save,
}));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

const renderWithClient = (ui: ReactNode) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
};

beforeEach(() => {
  getForms.mockReset();
  save.mockReset();
});
afterEach(cleanup);

describe("TaskFormsSlot (TB-173)", () => {
  it("draws nothing for a task without forms", async () => {
    getForms.mockResolvedValue([]);
    const { container } = renderWithClient(<TaskFormsSlot taskId="task-1" />);
    await act(async () => {});
    expect(getForms).toHaveBeenCalledWith("task-1");
    expect(container.innerHTML).toBe("");
  });

  it("shows a failed list with a retry", async () => {
    getForms.mockRejectedValueOnce(new HttpError(500, "boom"));
    getForms.mockResolvedValueOnce([taskForm()]);
    renderWithClient(<TaskFormsSlot taskId="task-1" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("tasks:forms.loadError");
    // The lazy section reads the failed list; it does not fetch it again.
    expect(getForms).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "tasks:forms.retry" }));
    expect(await screen.findByText("tasks:forms.title")).toBeTruthy();
    expect(screen.getByText("Seven types")).toBeTruthy();
  });
});

describe("TaskFormBlock (TB-173 F2/F3)", () => {
  it("opens a submitted form collapsed", () => {
    renderWithClient(
      <TaskFormBlock
        form={taskForm({
          status: "submitted",
          submittedAt: "2026-11-15T03:00:00.000Z",
        })}
        onReload={vi.fn()}
        taskId="task-1"
      />,
    );
    expect(screen.getByText("tasks:forms.status.submitted")).toBeTruthy();
    expect(screen.queryByText("Mood")).toBeNull();
  });

  it("opens a form changed after submit expanded and says so", () => {
    renderWithClient(
      <TaskFormBlock
        form={taskForm({ submittedAt: "2026-11-15T03:00:00.000Z" })}
        onReload={vi.fn()}
        taskId="task-1"
      />,
    );
    expect(screen.getByText("tasks:forms.status.changed")).toBeTruthy();
    expect(screen.getByText("Mood")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "tasks:forms.resubmit" }),
    ).toBeTruthy();
  });

  it("marks the questions that block a submit", async () => {
    const { container } = renderWithClient(
      <TaskFormBlock form={taskForm()} onReload={vi.fn()} taskId="task-1" />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "tasks:forms.submit" }),
      );
    });
    expect(screen.getByText("tasks:forms.submitIssues")).toBeTruthy();
    const marked = [...container.querySelectorAll("li[data-invalid]")].map(
      (li) => li.getAttribute("data-field-id"),
    );
    expect(marked).toEqual(["team", "name"]);
    expect(save).not.toHaveBeenCalled();
  });
});
