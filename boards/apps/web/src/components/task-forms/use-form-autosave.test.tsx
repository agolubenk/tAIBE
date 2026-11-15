import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { TaskForm } from "@/fetchers/task-form/get-task-forms";
import { SaveTaskFormError } from "@/fetchers/task-form/save-task-form-answers";
import { taskFormsKey } from "@/hooks/queries/task-form/use-task-forms";
import { taskForm } from "./form-test-template";
import { AUTOSAVE_DELAY_MS, useFormAutosave } from "./use-form-autosave";

const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/fetchers/task-form/save-task-form-answers", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  default: save,
}));

const saved = (rowVersion: number, submittedAt: string | null = null) => ({
  status: submittedAt ? "submitted" : "draft",
  rowVersion,
  submittedAt,
});

function setup(form: TaskForm = taskForm()) {
  const client = new QueryClient();
  client.setQueryData(taskFormsKey("task-1"), [form]);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useFormAutosave("task-1", form), { wrapper });
  return { client, ...hook };
}

const flush = () => act(async () => vi.advanceTimersByTimeAsync(0));
const sentAnswers = (call = 0) => save.mock.calls[call]?.[0]?.answers.answers;

beforeEach(() => {
  save.mockReset();
  save.mockResolvedValue(saved(1));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useFormAutosave (TB-173 F1/F2)", () => {
  it("saves a draft a second after the last change, without invalid values", async () => {
    vi.useFakeTimers();
    const { result } = setup();
    act(() => {
      result.current.change("mood", { v: 4 });
      result.current.change("dates", { v: ["2026-11-20", "2026-11-10"] });
    });
    expect(result.current.saveState.kind).toBe("pending");
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1));
    expect(save).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      formId: "form-1",
      submit: false,
      rowVersion: 0,
    });
    // The reversed interval stays here, next to its issue.
    expect(sentAnswers()).toEqual({ mood: { v: 4 } });
    expect(result.current.answers.dates).toEqual({
      v: ["2026-11-20", "2026-11-10"],
    });
    expect(result.current.issues).toEqual([
      { fieldId: "dates", code: "invalid_interval" },
    ]);
    expect(result.current.saveState.kind).toBe("saved");
  });

  it("keeps an answer to a field that a display rule hid in a draft", async () => {
    vi.useFakeTimers();
    const { result } = setup();
    act(() => {
      result.current.change("team", { v: true });
      result.current.change("size", { v: 3 });
      result.current.change("team", { v: false });
    });
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS));
    expect(sentAnswers()).toEqual({ team: { v: false }, size: { v: 3 } });
  });

  it("checks the whole form on submit and still saves the change as a draft", async () => {
    const { result } = setup();
    act(() => result.current.change("mood", { v: 2 }));
    let ok = true;
    await act(async () => {
      ok = await result.current.submit();
    });
    expect(ok).toBe(false);
    expect(result.current.issues).toEqual(
      expect.arrayContaining([
        { fieldId: "team", code: "required" },
        { fieldId: "name", code: "required" },
      ]),
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ submit: false });
  });

  it("submits a full form without hidden answers and keeps the cache current", async () => {
    const at = "2026-11-15T03:00:00.000Z";
    save.mockResolvedValue(saved(5, at));
    const { result, client } = setup(
      taskForm({
        answers: {
          form: "seven-types",
          version: 1,
          answers: { team: { v: false }, size: { v: 3 }, name: { v: "Ann" } },
        },
      }),
    );
    await act(async () => {
      expect(await result.current.submit()).toBe(true);
    });
    expect(save.mock.calls[0]?.[0]).toMatchObject({ submit: true });
    expect(sentAnswers()).toEqual({ team: { v: false }, name: { v: "Ann" } });
    expect(result.current.meta).toEqual(saved(5, at));
    const cached = client.getQueryData<TaskForm[]>(taskFormsKey("task-1"))?.[0];
    expect(cached).toMatchObject({ status: "submitted", rowVersion: 5 });
    expect(cached?.answers?.answers).toEqual(sentAnswers());
  });

  it("stops saving after a conflict and keeps what was typed", async () => {
    vi.useFakeTimers();
    save.mockRejectedValue(new SaveTaskFormError("row_version"));
    const { result } = setup();
    act(() => result.current.change("mood", { v: 4 }));
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS));
    expect(result.current.saveState).toEqual({
      kind: "failed",
      failure: "row_version",
    });
    act(() => result.current.change("mood", { v: 5 }));
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3));
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.answers.mood).toEqual({ v: 5 });
  });

  it("keeps the answers after a failed save and saves them on retry", async () => {
    vi.useFakeTimers();
    save.mockRejectedValueOnce(new SaveTaskFormError("failed"));
    const { result } = setup();
    act(() => result.current.change("mood", { v: 4 }));
    await act(async () => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS));
    expect(result.current.saveState.kind).toBe("failed");
    act(() => result.current.retry());
    await flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(sentAnswers(1)).toEqual({ mood: { v: 4 } });
    expect(result.current.saveState.kind).toBe("saved");
  });

  it("saves at once, with keepalive, when the card closes", async () => {
    vi.useFakeTimers();
    const { result, unmount } = setup();
    act(() => result.current.change("mood", { v: 4 }));
    unmount();
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1]).toEqual({ keepalive: true });
  });
});
