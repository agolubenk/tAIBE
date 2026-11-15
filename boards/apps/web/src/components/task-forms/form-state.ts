import {
  type Answer,
  type AnswerIssue,
  type AnswerIssueCode,
  type AnswerMap,
  type AnswersDoc,
  type FormTemplate,
  isEmptyValue,
  visibleFieldIds,
} from "@kaneo/forms";

// TB-173 web (a): pure helpers of the form block: progress, answer updates
// and issue texts. No React, so they are tested without a DOM.

/** The i18n key of each issue code of @kaneo/forms. */
export const ANSWER_ISSUE_KEYS: Record<AnswerIssueCode, string> = {
  required: "tasks:forms.issues.required",
  wrong_type: "tasks:forms.issues.wrongType",
  out_of_range: "tasks:forms.issues.outOfRange",
  invalid_option: "tasks:forms.issues.invalidOption",
  invalid_interval: "tasks:forms.issues.invalidInterval",
  too_long: "tasks:forms.issues.tooLong",
  unknown_field: "tasks:forms.issues.unknownField",
  version_mismatch: "tasks:forms.issues.versionMismatch",
};

/** The first issue of each field; `null` holds a whole-form issue. */
export function issuesByField(
  issues: readonly AnswerIssue[],
): Map<string | null, AnswerIssueCode> {
  const byField = new Map<string | null, AnswerIssueCode>();
  for (const issue of issues) {
    if (!byField.has(issue.fieldId)) byField.set(issue.fieldId, issue.code);
  }
  return byField;
}

/**
 * The issues after a draft check. A draft check finds every value issue but
 * no `required`, so value issues come from it and a `required` from the last
 * Submit stays shown until its field gets an issue or an answer.
 */
export function mergeIssues(
  shown: readonly AnswerIssue[],
  found: readonly AnswerIssue[],
): AnswerIssue[] {
  const checked = new Set(found.map((issue) => issue.fieldId));
  return [
    ...shown.filter(
      (issue) => issue.code === "required" && !checked.has(issue.fieldId),
    ),
    ...found,
  ];
}

/** The answer document of a form: a field without an answer has no entry. */
export function answersDoc(
  template: FormTemplate,
  answers: AnswerMap,
): AnswersDoc {
  const kept: [string, Answer][] = [];
  for (const [id, answer] of Object.entries(answers)) {
    if (answer) kept.push([id, answer]);
  }
  return {
    form: template.form,
    version: template.version,
    answers: Object.fromEntries(kept),
  };
}

/** Answered and shown fields: hidden fields count in neither. */
export function formProgress(
  template: FormTemplate,
  answers: AnswerMap,
): { answered: number; total: number } {
  const visible = visibleFieldIds(template, answers);
  let answered = 0;
  let total = 0;
  for (const field of template.fields) {
    if (!visible.has(field.id)) continue;
    total += 1;
    if (!isEmptyValue(field, answers[field.id]?.v)) answered += 1;
  }
  return { answered, total };
}

/**
 * The answer map with one answer changed. An answer with no value and no
 * note is removed, so a cleared field is empty again, not an empty answer.
 */
export function withAnswer(
  answers: AnswerMap,
  template: FormTemplate,
  fieldId: string,
  change: Partial<Answer>,
): AnswerMap {
  const field = template.fields.find((item) => item.id === fieldId);
  if (!field) return answers;
  const merged: Answer = { v: undefined, ...answers[fieldId], ...change };
  const note = merged.note?.trim() ? merged.note : undefined;
  const next: AnswerMap = { ...answers };
  if (isEmptyValue(field, merged.v) && !note) {
    delete next[fieldId];
  } else {
    next[fieldId] =
      note === undefined ? { v: merged.v } : { v: merged.v, note };
  }
  return next;
}
