import { z } from "zod";
import {
  type FieldOf,
  fieldIdSchema,
  type FormField,
  type FormTemplate,
  LIMITS,
} from "./schema";
import { visibleFieldIds } from "./show-if";

// Every field starts empty: a new answer set is `{}`. An empty answer is
// null, "", an absent key, or an interval/matrix with no part filled.

export const answerSchema = z.strictObject({
  v: z.unknown(),
  note: z.string().max(LIMITS.note).optional(),
});
export type Answer = z.infer<typeof answerSchema>;
export type AnswerMap = Partial<Record<string, Answer>>;

export const answersDocSchema = z.strictObject({
  form: z.string().min(1).max(80),
  version: z.number().int().min(1),
  answers: z.record(fieldIdSchema, answerSchema),
});
export type AnswersDoc = z.infer<typeof answersDocSchema>;

/** Stable codes; the web maps them to i18n keys. No text here. */
export type AnswerIssueCode =
  | "required"
  | "wrong_type"
  | "out_of_range"
  | "invalid_option"
  | "invalid_interval"
  | "too_long"
  | "unknown_field"
  | "version_mismatch";

export interface AnswerIssue {
  /** null for version_mismatch. */
  fieldId: string | null;
  code: AnswerIssueCode;
}

export interface AnswersCheck {
  ok: boolean;
  issues: AnswerIssue[];
  /** Answers to keep: shown fields only; empty ones need a note to stay. */
  answers: Record<string, Answer>;
}

/**
 * Checks an answer set against its template. Answers to hidden fields are
 * dropped, not errors. Choice answers are option indexes, so a set made for
 * another version of the template is refused as a whole.
 */
export function validateAnswers(
  template: FormTemplate,
  doc: Pick<AnswersDoc, "form" | "version" | "answers">,
): AnswersCheck {
  if (doc.form !== template.form || doc.version !== template.version) {
    return {
      ok: false,
      issues: [{ fieldId: null, code: "version_mismatch" }],
      answers: {},
    };
  }
  const issues: AnswerIssue[] = [];
  const known = new Set(template.fields.map((field) => field.id));
  for (const id of Object.keys(doc.answers)) {
    if (!known.has(id)) issues.push({ fieldId: id, code: "unknown_field" });
  }
  const visible = visibleFieldIds(template, doc.answers);
  const kept: Record<string, Answer> = {};
  for (const field of template.fields) {
    if (!visible.has(field.id)) continue;
    const answer = doc.answers[field.id];
    const empty = isEmptyValue(field, answer?.v);
    if ((answer?.note?.length ?? 0) > LIMITS.note) {
      issues.push({ fieldId: field.id, code: "too_long" });
    }
    if (empty) {
      if (field.required) issues.push({ fieldId: field.id, code: "required" });
    } else {
      const code = valueIssue(field, answer?.v);
      if (code) issues.push({ fieldId: field.id, code });
    }
    if (answer && (!empty || answer.note)) kept[field.id] = answer;
  }
  return { ok: issues.length === 0, issues, answers: kept };
}

/** True when the answer has no value: a required field reports `required`. */
export function isEmptyValue(field: FormField, value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (field.type === "interval" || field.type === "matrix") {
    return Array.isArray(value) && value.every((part) => part === null);
  }
  return false;
}

/** The issue of one non-empty value, or null when it fits the field. */
export function valueIssue(
  field: FormField,
  value: unknown,
): AnswerIssueCode | null {
  switch (field.type) {
    case "scale":
      return integerIssue(
        value,
        LIMITS.scale.min,
        LIMITS.scale.max,
        "out_of_range",
      );
    case "yesno":
      return typeof value === "boolean" ? null : "wrong_type";
    case "choice":
      return integerIssue(value, 0, field.options.length - 1, "invalid_option");
    case "interval":
      return intervalIssue(field, value);
    case "input":
      if (field.kind === "number") return finite(value) ? null : "wrong_type";
      return textIssue(value, LIMITS.inputText);
    case "text":
      return textIssue(value, LIMITS.text);
    case "matrix":
      return matrixIssue(field, value, field.required === true);
  }
}

function integerIssue(
  value: unknown,
  min: number,
  max: number,
  outside: AnswerIssueCode,
): AnswerIssueCode | null {
  if (!Number.isInteger(value)) return "wrong_type";
  const n = value as number;
  return n < min || n > max ? outside : null;
}

function textIssue(value: unknown, max: number): AnswerIssueCode | null {
  if (typeof value !== "string") return "wrong_type";
  return value.length > max ? "too_long" : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_DATE.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
  );
}

function intervalIssue(
  field: FieldOf<"interval">,
  value: unknown,
): AnswerIssueCode | null {
  if (!Array.isArray(value) || value.length !== 2) return "wrong_type";
  const [from, to] = value as [unknown, unknown];
  // One end only is an unfinished interval; an end of the wrong kind is not.
  const broken = (): AnswerIssueCode =>
    from === null || to === null ? "invalid_interval" : "wrong_type";
  if (field.kind === "number") {
    if (!finite(from) || !finite(to)) return broken();
    return from > to ? "invalid_interval" : null;
  }
  if (!isDate(from) || !isDate(to)) return broken();
  return from > to ? "invalid_interval" : null;
}

function matrixIssue(
  field: FieldOf<"matrix">,
  value: unknown,
  required: boolean,
): AnswerIssueCode | null {
  if (!Array.isArray(value) || value.length !== field.rows.length) {
    return "wrong_type";
  }
  for (const cell of value) {
    if (cell === null) {
      if (required) return "required";
      continue;
    }
    const code = integerIssue(cell, 0, field.cols.length - 1, "invalid_option");
    if (code) return code;
  }
  return null;
}
