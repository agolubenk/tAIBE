import { type AnswersDoc, isEmptyValue, valueIssue } from "./answers";
import type { FormField, FormTemplate } from "./schema";
import { visibleFieldIds } from "./show-if";

export interface AnswerLabels {
  yes: string;
  no: string;
  /** A matrix row with no column chosen. */
  empty: string;
}

/** The grill's words, as in its export `t-boards-grill-answers.json`. */
export const RU_LABELS: AnswerLabels = { yes: "да", no: "нет", empty: "—" };

/** One answer as the grill exported it: `{id, q, v, answer, note}`. */
export interface ExportEntry {
  id: string;
  q: string;
  v: unknown;
  answer: unknown;
  note: string;
}

export interface FormExport {
  form: string;
  version: number;
  submitted: boolean;
  /** Shown fields with a valid value. */
  answered: number;
  /** Shown fields. */
  total: number;
  at: string;
  answers: ExportEntry[];
}

/**
 * The answer in words: a choice gives its option, yes/no a label, a matrix
 * one "row: column" line per row; other types give the value itself.
 */
export function humanAnswer(
  field: FormField,
  value: unknown,
  labels: AnswerLabels = RU_LABELS,
): unknown {
  if (value === null || value === undefined) return null;
  if (field.type === "choice" && typeof value === "number") {
    return field.options[value] ?? value;
  }
  if (field.type === "yesno") return value ? labels.yes : labels.no;
  if (field.type === "matrix" && Array.isArray(value)) {
    return field.rows.map((row, index) => {
      const cell: unknown = value[index];
      if (typeof cell !== "number") return `${row}: ${labels.empty}`;
      return `${row}: ${field.cols[cell] ?? cell}`;
    });
  }
  return value;
}

/**
 * The answers in the grill's export format, in template order. Hidden fields
 * and fields with neither a value nor a note are left out.
 */
export function exportAnswers(
  template: FormTemplate,
  doc: Pick<AnswersDoc, "answers">,
  options: { submitted: boolean; at: string; labels?: AnswerLabels },
): FormExport {
  const visible = visibleFieldIds(template, doc.answers);
  const entries: ExportEntry[] = [];
  let answered = 0;
  for (const field of template.fields) {
    if (!visible.has(field.id)) continue;
    const answer = doc.answers[field.id];
    const empty = isEmptyValue(field, answer?.v);
    if (!empty && valueIssue(field, answer?.v) === null) answered += 1;
    if (!answer || (empty && !answer.note)) continue;
    const v = empty ? null : answer.v;
    entries.push({
      id: field.id,
      q: field.q,
      v,
      answer: humanAnswer(field, v, options.labels),
      note: answer.note ?? "",
    });
  }
  return {
    form: template.form,
    version: template.version,
    submitted: options.submitted,
    answered,
    total: visible.size,
    at: options.at,
    answers: entries,
  };
}
