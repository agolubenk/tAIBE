import { type FieldOf, type FormField, LIMITS } from "@kaneo/forms";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

// TB-173 web (a): one input per field type of @kaneo/forms. Every text of a
// template is plain text: React renders it as text, never as HTML. A value
// is what the package checks: scale 1..5, yes/no boolean, choice and matrix
// option indexes, interval [from, to], input number or text, text string.

export type FieldInputProps<T extends FormField["type"]> = {
  field: FieldOf<T>;
  value: unknown;
  onChange: (value: unknown) => void;
  /** The id of the question's text: it names the input. */
  labelId: string;
  invalid: boolean;
  disabled: boolean;
};

const SCALE = Array.from(
  { length: LIMITS.scale.max - LIMITS.scale.min + 1 },
  (_, index) => LIMITS.scale.min + index,
);

/** Radio values are strings; the answer keeps the number. */
const indexValue = (value: unknown) =>
  Number.isInteger(value) ? String(value) : "";

export function ScaleInput({
  field,
  value,
  onChange,
  labelId,
  invalid,
  disabled,
}: FieldInputProps<"scale">) {
  return (
    <RadioGroup
      aria-invalid={invalid || undefined}
      aria-labelledby={labelId}
      className="flex-row flex-wrap items-center gap-x-3 gap-y-1.5"
      disabled={disabled}
      onValueChange={(next) => onChange(Number(next))}
      value={indexValue(value)}
    >
      <span className="text-muted-foreground text-xs">{field.lo}</span>
      {SCALE.map((point) => (
        <Label className="gap-1.5 font-normal" key={point}>
          <Radio value={String(point)} />
          {point}
        </Label>
      ))}
      <span className="text-muted-foreground text-xs">{field.hi}</span>
    </RadioGroup>
  );
}

export function YesNoInput({
  value,
  onChange,
  labelId,
  invalid,
  disabled,
}: FieldInputProps<"yesno">) {
  const { t } = useTranslation();
  return (
    <RadioGroup
      aria-invalid={invalid || undefined}
      aria-labelledby={labelId}
      className="flex-row gap-4"
      disabled={disabled}
      onValueChange={(next) => onChange(next === "yes")}
      value={value === true ? "yes" : value === false ? "no" : ""}
    >
      <Label className="gap-1.5 font-normal">
        <Radio value="yes" />
        {t("tasks:forms.yes")}
      </Label>
      <Label className="gap-1.5 font-normal">
        <Radio value="no" />
        {t("tasks:forms.no")}
      </Label>
    </RadioGroup>
  );
}

export function ChoiceInput({
  field,
  value,
  onChange,
  labelId,
  invalid,
  disabled,
}: FieldInputProps<"choice">) {
  return (
    <RadioGroup
      aria-invalid={invalid || undefined}
      aria-labelledby={labelId}
      className="gap-2"
      disabled={disabled}
      onValueChange={(next) => onChange(Number(next))}
      value={indexValue(value)}
    >
      {field.options.map((option, index) => (
        <Label
          className="items-start gap-2 font-normal"
          // Options are fixed by the template version; the index is the answer.
          // biome-ignore lint/suspicious/noArrayIndexKey: the index is the value
          key={index}
        >
          <Radio className="mt-0.5" value={String(index)} />
          <span className="whitespace-pre-wrap">{option}</span>
        </Label>
      ))}
    </RadioGroup>
  );
}

/**
 * A number typed as text: "-" or "1." are kept while the person types, and
 * the answer gets a number only when the text is one (else null).
 */
function NumberText({
  value,
  onChange,
  ...props
}: {
  value: unknown;
  onChange: (value: number | null) => void;
  "aria-labelledby": string;
  "aria-invalid"?: boolean;
  disabled: boolean;
}) {
  const [text, setText] = useState(() =>
    typeof value === "number" ? String(value) : "",
  );
  useEffect(() => {
    setText((current) =>
      Number(current) === value && current.trim() !== ""
        ? current
        : typeof value === "number"
          ? String(value)
          : "",
    );
  }, [value]);
  return (
    <Input
      {...props}
      inputMode="decimal"
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const number = Number(next.replace(",", "."));
        onChange(next.trim() !== "" && Number.isFinite(number) ? number : null);
      }}
      value={text}
    />
  );
}

export function IntervalInput({
  field,
  value,
  onChange,
  labelId,
  invalid,
  disabled,
}: FieldInputProps<"interval">) {
  const { t } = useTranslation();
  const [from, to] = Array.isArray(value)
    ? (value as [unknown, unknown])
    : [null, null];
  const set = (index: 0 | 1, part: unknown) => {
    const next: [unknown, unknown] = [from ?? null, to ?? null];
    next[index] = part;
    onChange(next[0] === null && next[1] === null ? null : next);
  };
  // Each end is named by the question and its own label ("From", "To").
  const end = (index: 0 | 1, part: unknown, nameId: string) =>
    field.kind === "number" ? (
      <NumberText
        aria-invalid={invalid || undefined}
        aria-labelledby={`${labelId} ${nameId}`}
        disabled={disabled}
        onChange={(next) => set(index, next)}
        value={part}
      />
    ) : (
      <Input
        aria-invalid={invalid || undefined}
        aria-labelledby={`${labelId} ${nameId}`}
        disabled={disabled}
        onChange={(event) => set(index, event.target.value || null)}
        type="date"
        value={typeof part === "string" ? part : ""}
      />
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-xs" id={`${labelId}-from`}>
        {t("tasks:forms.intervalFrom")}
      </span>
      <div className="w-36">{end(0, from, `${labelId}-from`)}</div>
      <span className="text-muted-foreground text-xs" id={`${labelId}-to`}>
        {t("tasks:forms.intervalTo")}
      </span>
      <div className="w-36">{end(1, to, `${labelId}-to`)}</div>
      {field.unit ? (
        <span className="text-muted-foreground text-sm">{field.unit}</span>
      ) : null}
    </div>
  );
}

export function TextLineInput({
  field,
  value,
  onChange,
  labelId,
  invalid,
  disabled,
}: FieldInputProps<"input">) {
  return (
    <div className="flex items-center gap-2">
      {field.kind === "number" ? (
        <div className="w-40">
          <NumberText
            aria-invalid={invalid || undefined}
            aria-labelledby={labelId}
            disabled={disabled}
            onChange={onChange}
            value={value}
          />
        </div>
      ) : (
        <Input
          aria-invalid={invalid || undefined}
          aria-labelledby={labelId}
          disabled={disabled}
          maxLength={LIMITS.inputText}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          value={typeof value === "string" ? value : ""}
        />
      )}
      {field.unit ? (
        <span className="text-muted-foreground text-sm">{field.unit}</span>
      ) : null}
    </div>
  );
}

export function LongTextInput({
  field,
  value,
  onChange,
  labelId,
  invalid,
  disabled,
}: FieldInputProps<"text">) {
  return (
    <Textarea
      aria-invalid={invalid || undefined}
      aria-labelledby={labelId}
      disabled={disabled}
      maxLength={LIMITS.text}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder}
      value={typeof value === "string" ? value : ""}
    />
  );
}

/**
 * One radio group per row. On a wide screen the column names are a header
 * and each radio is named for screen readers; on a phone each row lists its
 * columns with their names.
 */
export function MatrixInput({
  field,
  value,
  onChange,
  labelId,
  invalid,
  disabled,
}: FieldInputProps<"matrix">) {
  const cells: (number | null)[] = Array.isArray(value)
    ? field.rows.map((_, row) =>
        Number.isInteger(value[row]) ? (value[row] as number) : null,
      )
    : field.rows.map(() => null);
  const set = (row: number, col: number) => {
    const next = [...cells];
    next[row] = col;
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <div aria-hidden="true" className="hidden gap-2 sm:flex">
        <span className="flex-1" />
        {field.cols.map((col, index) => (
          <span
            className="line-clamp-2 w-18 text-center text-muted-foreground text-xs"
            // biome-ignore lint/suspicious/noArrayIndexKey: the index is the value
            key={index}
            title={col}
          >
            {col}
          </span>
        ))}
      </div>
      {field.rows.map((row, rowIndex) => (
        <div
          className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2"
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are fixed by the version
          key={rowIndex}
        >
          <span
            className="whitespace-pre-wrap text-sm sm:flex-1"
            id={`${labelId}-row-${rowIndex}`}
          >
            {row}
          </span>
          <RadioGroup
            aria-invalid={(invalid && cells[rowIndex] === null) || undefined}
            aria-labelledby={`${labelId} ${labelId}-row-${rowIndex}`}
            className="gap-1.5 sm:flex-row sm:gap-2"
            disabled={disabled}
            onValueChange={(next) => set(rowIndex, Number(next))}
            value={indexValue(cells[rowIndex])}
          >
            {field.cols.map((col, colIndex) => (
              <Label
                className="gap-2 font-normal sm:w-18 sm:justify-center"
                // biome-ignore lint/suspicious/noArrayIndexKey: the index is the value
                key={colIndex}
              >
                <Radio value={String(colIndex)} />
                <span className="sm:sr-only">{col}</span>
              </Label>
            ))}
          </RadioGroup>
        </div>
      ))}
    </div>
  );
}
