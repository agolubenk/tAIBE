import { type AnswerIssue, exportAnswers } from "@kaneo/forms";
import { ChevronRight } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { TaskForm } from "@/fetchers/task-form/get-task-forms";
import { cn } from "@/lib/cn";
import { FormRenderer } from "./form-renderer";
import { answersDoc, formProgress } from "./form-state";
import {
  type FormMeta,
  type SaveState,
  useFormAutosave,
} from "./use-form-autosave";

// TB-173 F3: a block per attached form. The header holds the title, the
// progress and the status; a draft opens expanded, a submitted form collapsed.

type Props = {
  taskId: string;
  form: TaskForm;
  onReload: () => void;
};

export function TaskFormBlock({ taskId, form, onReload }: Props) {
  const { t } = useTranslation();
  const { template } = form;
  const bodyRef = useRef<HTMLDivElement>(null);
  const { answers, meta, saveState, issues, change, submit, retry } =
    useFormAutosave(taskId, form);
  const [open, setOpen] = useState(form.status !== "submitted");
  const progress = useMemo(
    () => formProgress(template, answers),
    [template, answers],
  );
  const stopped =
    saveState.kind === "failed" &&
    (saveState.failure === "row_version" ||
      saveState.failure === "version_mismatch" ||
      saveState.failure === "forbidden");

  const onSubmit = async () => {
    const ok = await submit();
    if (!ok) focusFirstIssue(bodyRef.current);
  };

  const onExport = () => {
    const data = exportAnswers(template, answersDoc(template, answers), {
      submitted: meta.status === "submitted",
      at: new Date().toISOString(),
    });
    downloadJson(`${template.form}-v${template.version}.json`, data);
  };

  return (
    <Collapsible
      className="rounded-lg border border-border"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {template.title}
        </span>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {t("tasks:forms.progress", {
            answered: progress.answered,
            total: progress.total,
          })}
        </span>
        <StatusBadge meta={meta} />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-4 px-3 pt-1 pb-3" ref={bodyRef}>
          <FormRenderer
            answers={answers}
            disabled={stopped}
            issues={issues}
            onAnswerChange={change}
            template={template}
          />
          <div className="flex flex-wrap items-center gap-2 border-border border-t pt-3">
            <SaveLine
              issues={issues}
              onReload={onReload}
              onRetry={retry}
              state={saveState}
            />
            <div className="ml-auto flex items-center gap-2">
              <Button onClick={onExport} size="sm" variant="ghost">
                {t("tasks:forms.export")}
              </Button>
              <Button
                disabled={stopped}
                onClick={() => void onSubmit()}
                size="sm"
              >
                {meta.submittedAt
                  ? t("tasks:forms.resubmit")
                  : t("tasks:forms.submit")}
              </Button>
            </div>
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function StatusBadge({ meta }: { meta: FormMeta }) {
  const { t } = useTranslation();
  if (meta.status === "submitted") {
    return (
      <Badge className="shrink-0" variant="success">
        {t("tasks:forms.status.submitted")}
      </Badge>
    );
  }
  if (meta.submittedAt) {
    return (
      <Badge className="shrink-0" variant="warning">
        {t("tasks:forms.status.changed")}
      </Badge>
    );
  }
  return (
    <Badge className="shrink-0" variant="secondary">
      {t("tasks:forms.status.draft")}
    </Badge>
  );
}

const FAILURE_KEYS = {
  row_version: "tasks:forms.save.rowVersion",
  version_mismatch: "tasks:forms.save.versionMismatch",
  forbidden: "tasks:forms.save.forbidden",
  invalid: "tasks:forms.save.invalid",
  failed: "tasks:forms.save.failed",
} as const;

const PROGRESS_KEYS = {
  pending: "tasks:forms.save.pending",
  saving: "tasks:forms.save.saving",
  saved: "tasks:forms.save.saved",
} as const;

function SaveLine({
  state,
  issues,
  onRetry,
  onReload,
}: {
  state: SaveState;
  issues: readonly AnswerIssue[];
  onRetry: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  let text: string | null = null;
  let action: { label: string; run: () => void } | null = null;
  if (state.kind === "failed") {
    text = t(FAILURE_KEYS[state.failure]);
    if (
      state.failure === "row_version" ||
      state.failure === "version_mismatch"
    ) {
      action = { label: t("tasks:forms.reload"), run: onReload };
    } else if (state.failure !== "forbidden") {
      action = { label: t("tasks:forms.retry"), run: onRetry };
    }
  } else if (issues.some((issue) => issue.code === "required")) {
    text = t("tasks:forms.submitIssues");
  } else if (issues.length > 0) {
    text = t("tasks:forms.save.invalid");
  } else if (state.kind !== "idle") {
    text = t(PROGRESS_KEYS[state.kind]);
  }
  const failed = state.kind === "failed" || issues.length > 0;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <p
        aria-live="polite"
        className={cn(
          "text-xs",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {text}
      </p>
      {action ? (
        <Button onClick={action.run} size="xs" variant="outline">
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

/** Scrolls to the first question with an issue and focuses its input. */
function focusFirstIssue(body: HTMLElement | null) {
  const question = body?.querySelector<HTMLElement>("li[data-invalid]");
  if (!question) return;
  question.scrollIntoView?.({ block: "center", behavior: "smooth" });
  question
    .querySelector<HTMLElement>(
      'input:not([type="hidden"]), textarea, [role="radio"]',
    )
    ?.focus({ preventScroll: true });
}

function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(data, null, 2)}\n`], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
