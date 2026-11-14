// @kaneo/forms — one code for the web and the API (R-027, TB-173): the seven
// field types, the template schema, the display rule with its cycle check,
// answer checks and the grill's JSON export. No React, no I/O.
// The grill template (fixtures/t-boards-grill.form.json) is for tests and
// imports only: it is not exported here, so it stays out of the web bundle.

export {
  type Answer,
  type AnswerIssue,
  type AnswerIssueCode,
  type AnswerMap,
  type AnswersCheck,
  type AnswersDoc,
  answerSchema,
  answersDocSchema,
  isEmptyValue,
  validateAnswers,
  valueIssue,
} from "./answers";
export {
  type AnswerLabels,
  type ExportEntry,
  exportAnswers,
  type FormExport,
  humanAnswer,
  RU_LABELS,
} from "./export";
export {
  FIELD_TYPES,
  type FieldOf,
  type FieldType,
  type FormField,
  type FormTemplate,
  fieldIdSchema,
  fieldSchema,
  formTemplateSchema,
  LIMITS,
  SHOW_IF_TARGETS,
  showIfSchema,
  type TemplateIssue,
  type TemplateIssueCode,
  templateIssues,
} from "./schema";
export { findShowIfCycle, visibleFieldIds } from "./show-if";
