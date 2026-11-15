import {
  type Answer,
  type AnswerIssue,
  type AnswerMap,
  type FormField,
  type FormTemplate,
  LIMITS,
  visibleFieldIds,
} from "@kaneo/forms";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ChoiceInput,
  IntervalInput,
  LongTextInput,
  MatrixInput,
  ScaleInput,
  TextLineInput,
  YesNoInput,
} from "./form-fields";
import { ANSWER_ISSUE_KEYS, issuesByField } from "./form-state";

// TB-173 web (a): a template of @kaneo/forms as questions with inputs. Only
// shown fields are drawn (display rules, visibleFieldIds); answers to hidden
// fields stay in the map, so a toggled rule brings them back.

type Props = {
  template: FormTemplate;
  answers: AnswerMap;
  onAnswerChange: (fieldId: string, change: Partial<Answer>) => void;
  issues?: readonly AnswerIssue[];
  disabled?: boolean;
};

export function FormRenderer({
  template,
  answers,
  onAnswerChange,
  issues = [],
  disabled = false,
}: Props) {
  const visible = useMemo(
    () => visibleFieldIds(template, answers),
    [template, answers],
  );
  const byField = useMemo(() => issuesByField(issues), [issues]);
  return (
    <ol className="flex flex-col gap-5">
      {template.fields
        .filter((field) => visible.has(field.id))
        .map((field) => (
          <FormQuestion
            answer={answers[field.id]}
            disabled={disabled}
            field={field}
            issue={byField.get(field.id)}
            key={field.id}
            onChange={(change) => onAnswerChange(field.id, change)}
          />
        ))}
    </ol>
  );
}

function FormQuestion({
  field,
  answer,
  issue,
  onChange,
  disabled,
}: {
  field: FormField;
  answer: Answer | undefined;
  issue: keyof typeof ANSWER_ISSUE_KEYS | undefined;
  onChange: (change: Partial<Answer>) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [noteOpen, setNoteOpen] = useState(Boolean(answer?.note));
  const invalid = issue !== undefined;
  return (
    <li
      className="flex flex-col gap-2"
      data-field-id={field.id}
      data-invalid={invalid || undefined}
    >
      <div className="flex flex-col gap-0.5">
        <p className="whitespace-pre-wrap font-medium text-sm" id={`${id}-q`}>
          {field.q}
          {field.required ? (
            <span className="text-destructive">
              <span aria-hidden="true"> *</span>
              <span className="sr-only"> ({t("tasks:forms.required")})</span>
            </span>
          ) : null}
        </p>
        {field.help ? (
          <p className="whitespace-pre-wrap text-muted-foreground text-xs">
            {field.help}
          </p>
        ) : null}
      </div>
      <FieldInput
        disabled={disabled}
        field={field}
        invalid={invalid}
        labelId={`${id}-q`}
        onChange={(v) => onChange({ v })}
        value={answer?.v}
      />
      {invalid ? (
        <p className="text-destructive text-xs" id={`${id}-issue`}>
          {t(ANSWER_ISSUE_KEYS[issue])}
        </p>
      ) : null}
      {noteOpen ? (
        <Textarea
          aria-label={t("tasks:forms.note")}
          disabled={disabled}
          maxLength={LIMITS.note}
          onChange={(event) => onChange({ note: event.target.value })}
          placeholder={t("tasks:forms.note")}
          value={answer?.note ?? ""}
        />
      ) : (
        <Button
          className="self-start"
          disabled={disabled}
          onClick={() => setNoteOpen(true)}
          size="xs"
          variant="ghost"
        >
          {t("tasks:forms.addNote")}
        </Button>
      )}
    </li>
  );
}

function FieldInput({
  field,
  ...props
}: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
  labelId: string;
  invalid: boolean;
  disabled: boolean;
}) {
  switch (field.type) {
    case "scale":
      return <ScaleInput field={field} {...props} />;
    case "yesno":
      return <YesNoInput field={field} {...props} />;
    case "choice":
      return <ChoiceInput field={field} {...props} />;
    case "interval":
      return <IntervalInput field={field} {...props} />;
    case "input":
      return <TextLineInput field={field} {...props} />;
    case "text":
      return <LongTextInput field={field} {...props} />;
    case "matrix":
      return <MatrixInput field={field} {...props} />;
  }
}
