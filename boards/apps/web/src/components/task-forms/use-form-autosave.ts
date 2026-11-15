import {
  type Answer,
  type AnswerIssue,
  type AnswerMap,
  validateAnswers,
} from "@kaneo/forms";
import { useQueryClient } from "@tanstack/react-query";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  TaskForm,
  TaskFormStatus,
} from "@/fetchers/task-form/get-task-forms";
import saveTaskFormAnswers, {
  type SaveFailure,
  SaveTaskFormError,
} from "@/fetchers/task-form/save-task-form-answers";
import { taskFormsKey } from "@/hooks/queries/task-form/use-task-forms";
import { mergeIssues, withAnswer } from "./form-state";

// TB-173 F1/F2: every change is saved as a draft one second after the last
// keystroke; Submit checks the whole form first. The answers live here while
// the form is open, so a slow or failed save never takes back what was typed.

export const AUTOSAVE_DELAY_MS = 1000;
// A save that outlives a closed tab (keepalive) may carry at most 64 KiB.
const KEEPALIVE_MAX_BYTES = 60_000;
// After these the saved copy differs from this one: wait for a reload.
const STOPPING: ReadonlySet<SaveFailure> = new Set([
  "row_version",
  "version_mismatch",
  "forbidden",
]);

export type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "failed"; failure: SaveFailure };

export type FormMeta = {
  status: TaskFormStatus;
  rowVersion: number;
  submittedAt: string | null;
};

type Timer = ReturnType<typeof setTimeout> | null;

function clearTimer(timer: RefObject<Timer>) {
  if (timer.current) clearTimeout(timer.current);
  timer.current = null;
}

export function useFormAutosave(taskId: string, form: TaskForm) {
  const queryClient = useQueryClient();
  const { template } = form;
  const [answers, setAnswers] = useState<AnswerMap>(
    () => form.answers?.answers ?? {},
  );
  const [meta, setMeta] = useState<FormMeta>(() => ({
    status: form.status,
    rowVersion: form.rowVersion,
    submittedAt: form.submittedAt,
  }));
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [issues, setIssues] = useState<AnswerIssue[]>([]);

  const answersRef = useRef(answers);
  const rowVersionRef = useRef(form.rowVersion);
  const dirtyRef = useRef(false);
  const stoppedRef = useRef(false);
  const runningRef = useRef<Promise<unknown> | null>(null);
  const timerRef = useRef<Timer>(null);

  /**
   * One save at a time; a later one waits and sends the newest answers.
   * True when the asked save (a submit or a draft) went through.
   */
  const save = useCallback(
    async (submit: boolean, keepalive = false): Promise<boolean> => {
      while (runningRef.current) await runningRef.current;
      if (stoppedRef.current) return false;
      if (!submit && !dirtyRef.current) return true;
      const doc = {
        form: template.form,
        version: template.version,
        answers: answersRef.current,
      };
      let draft = !submit;
      if (submit) {
        const full = validateAnswers(template, doc);
        if (!full.ok) {
          setIssues(full.issues);
          if (!dirtyRef.current) return false;
          draft = true; // the changes are still saved, as a draft
        }
      }
      const check = validateAnswers(template, doc, { draft });
      // A draft keeps an invalid value here, next to its issue, and sends
      // the rest: the server refuses a draft with any invalid value.
      const invalid = new Set(check.issues.map((issue) => issue.fieldId));
      const sent: AnswerMap = Object.fromEntries(
        Object.entries(check.answers).filter(([id]) => !invalid.has(id)),
      );
      if (draft) setIssues((prev) => mergeIssues(prev, check.issues));

      const request = {
        formId: form.id,
        answers: { ...doc, answers: sent },
        submit: !draft,
        rowVersion: rowVersionRef.current,
      };
      const small =
        new TextEncoder().encode(JSON.stringify(request)).length <
        KEEPALIVE_MAX_BYTES;
      dirtyRef.current = false;
      setSaveState({ kind: "saving" });
      const running = saveTaskFormAnswers(request, {
        keepalive: keepalive && small,
      }).then(
        (saved) => {
          rowVersionRef.current = saved.rowVersion;
          setMeta(saved);
          if (!draft) setIssues([]);
          // The next open of the card starts from what the server holds.
          queryClient.setQueryData<TaskForm[]>(taskFormsKey(taskId), (forms) =>
            forms?.map((item) =>
              item.id === form.id
                ? { ...item, ...saved, answers: request.answers }
                : item,
            ),
          );
          setSaveState({ kind: dirtyRef.current ? "pending" : "saved" });
          return true;
        },
        (error: unknown) => {
          const failure =
            error instanceof SaveTaskFormError ? error.failure : "failed";
          if (error instanceof SaveTaskFormError && failure === "invalid") {
            setIssues(error.issues);
          }
          if (STOPPING.has(failure)) stoppedRef.current = true;
          dirtyRef.current = true;
          setSaveState({ kind: "failed", failure });
          return false;
        },
      );
      runningRef.current = running;
      try {
        return (await running) && draft === !submit;
      } finally {
        if (runningRef.current === running) runningRef.current = null;
      }
    },
    [form.id, queryClient, taskId, template],
  );

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const change = useCallback(
    (fieldId: string, part: Partial<Answer>) => {
      const next = withAnswer(answersRef.current, template, fieldId, part);
      if (next === answersRef.current) return;
      answersRef.current = next;
      setAnswers(next);
      setIssues((prev) => prev.filter((issue) => issue.fieldId !== fieldId));
      dirtyRef.current = true;
      if (stoppedRef.current) return;
      setSaveState({ kind: "pending" });
      clearTimer(timerRef);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void saveRef.current(false);
      }, AUTOSAVE_DELAY_MS);
    },
    [template],
  );

  const submit = useCallback(() => {
    clearTimer(timerRef);
    return save(true);
  }, [save]);

  const retry = useCallback(() => {
    clearTimer(timerRef);
    void save(false);
  }, [save]);

  // Leaving the card or the tab (a phone switching apps) saves at once.
  useEffect(() => {
    const flush = () => {
      clearTimer(timerRef);
      if (dirtyRef.current && !stoppedRef.current) {
        void saveRef.current(false, true);
      }
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, []);

  return { answers, meta, saveState, issues, change, submit, retry };
}
