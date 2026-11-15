import { z } from "zod";
import { LIMITS } from "./limits";
import { findShowIfCycle } from "./show-if";

// R-027 (TB-173): a form template is JSON that agents send through MCP and
// the web renders. Every text in it is plain text: the web shows it as text,
// never as HTML or markdown.

export const FIELD_TYPES = [
  "scale",
  "yesno",
  "choice",
  "interval",
  "input",
  "text",
  "matrix",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** The types a display rule may point at: one answer, compared with `===`. */
export const SHOW_IF_TARGETS = ["choice", "yesno", "scale"] as const;

const PLAIN = "Plain text: shown as text, never as HTML or markdown.";

const plain = (max: number) =>
  z.string().trim().min(1).max(max).describe(PLAIN);

export const fieldIdSchema = z
  .string()
  // __proto__ is no own key of a parsed record: its answer would vanish.
  .regex(/^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9_-]{1,40}$/)
  .describe("The field's id, unique in the template; answers are keyed by it.");

export const showIfSchema = z
  .strictObject({
    field: fieldIdSchema,
    equals: z.union([z.number(), z.boolean(), z.string().max(LIMITS.q)]),
  })
  .describe(
    "The field is shown only if the answer to `field` equals `equals` and `field` is shown itself. `field` is a choice (option index), yes/no (boolean) or scale (1..5).",
  );

const base = {
  id: fieldIdSchema,
  q: plain(LIMITS.q).describe(`The question. ${PLAIN}`),
  help: plain(LIMITS.help).optional().describe(`A hint. ${PLAIN}`),
  required: z.boolean().optional(),
  showIf: showIfSchema.optional(),
};

const scaleField = z.strictObject({
  ...base,
  type: z.literal("scale"),
  lo: plain(LIMITS.label).describe(`The label of 1. ${PLAIN}`),
  hi: plain(LIMITS.label).describe(`The label of 5. ${PLAIN}`),
});

const yesnoField = z.strictObject({ ...base, type: z.literal("yesno") });

const choiceField = z.strictObject({
  ...base,
  type: z.literal("choice"),
  options: z
    .array(plain(LIMITS.option))
    .min(LIMITS.options.min)
    .max(LIMITS.options.max)
    .describe(
      "The options. The answer is the option's index, so a change of options needs a new template version.",
    ),
});

const intervalField = z.strictObject({
  ...base,
  type: z.literal("interval"),
  kind: z.enum(["number", "date"]),
  unit: plain(LIMITS.unit).optional(),
});

const inputField = z.strictObject({
  ...base,
  type: z.literal("input"),
  kind: z.enum(["number", "text"]),
  unit: plain(LIMITS.unit).optional(),
  placeholder: plain(LIMITS.placeholder).optional(),
});

const textField = z.strictObject({
  ...base,
  type: z.literal("text"),
  placeholder: plain(LIMITS.placeholder).optional(),
});

const matrixField = z.strictObject({
  ...base,
  type: z.literal("matrix"),
  rows: z.array(plain(LIMITS.option)).min(1).max(LIMITS.rows),
  cols: z
    .array(plain(LIMITS.label))
    .min(LIMITS.cols.min)
    .max(LIMITS.cols.max)
    .describe("One column per row is chosen; the answer holds its index."),
});

export const fieldSchema = z.discriminatedUnion("type", [
  scaleField,
  yesnoField,
  choiceField,
  intervalField,
  inputField,
  textField,
  matrixField,
]);
export type FormField = z.infer<typeof fieldSchema>;
export type FieldOf<T extends FieldType> = Extract<FormField, { type: T }>;

/** Stable codes of template issues; the web maps them to i18n keys. */
export type TemplateIssueCode =
  | "duplicate_id"
  | "unknown_target"
  | "target_type"
  | "invalid_equals"
  | "cycle";

export const formTemplateSchema = z
  .strictObject({
    form: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
      .describe("The template's slug."),
    version: z
      .number()
      .int()
      .min(1)
      .describe(
        "Answers name this version; a change of fields needs a new one.",
      ),
    title: plain(LIMITS.title),
    fields: z.array(fieldSchema).min(1).max(LIMITS.fields),
  })
  .superRefine((template, ctx) => {
    for (const issue of templateIssues(template.fields)) {
      ctx.addIssue({
        code: "custom",
        message: issue.code,
        path: ["fields", issue.index, ...issue.path],
        params: { code: issue.code, ids: issue.ids },
      });
    }
  });
export type FormTemplate = z.infer<typeof formTemplateSchema>;

export interface TemplateIssue {
  code: TemplateIssueCode;
  index: number;
  path: string[];
  ids?: string[];
}

/** Checks that the schema of one field cannot: ids, display rules, cycles. */
export function templateIssues(fields: readonly FormField[]): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const byId = new Map<string, FormField>();
  fields.forEach((field, index) => {
    if (byId.has(field.id)) {
      issues.push({ code: "duplicate_id", index, path: ["id"] });
    } else {
      byId.set(field.id, field);
    }
  });
  fields.forEach((field, index) => {
    if (!field.showIf) return;
    const target = byId.get(field.showIf.field);
    if (!target) {
      issues.push({ code: "unknown_target", index, path: ["showIf", "field"] });
    } else if (!isShowIfTarget(target)) {
      issues.push({ code: "target_type", index, path: ["showIf", "field"] });
    } else if (!equalsFits(target, field.showIf.equals)) {
      issues.push({
        code: "invalid_equals",
        index,
        path: ["showIf", "equals"],
      });
    }
  });
  const cycle = findShowIfCycle(fields);
  if (cycle) {
    const first = cycle[0];
    issues.push({
      code: "cycle",
      index: fields.findIndex((field) => field.id === first),
      path: ["showIf"],
      ids: cycle,
    });
  }
  return issues;
}

function isShowIfTarget(
  field: FormField,
): field is FieldOf<(typeof SHOW_IF_TARGETS)[number]> {
  return (SHOW_IF_TARGETS as readonly string[]).includes(field.type);
}

function equalsFits(
  target: FieldOf<(typeof SHOW_IF_TARGETS)[number]>,
  equals: unknown,
): boolean {
  if (target.type === "yesno") return typeof equals === "boolean";
  if (!Number.isInteger(equals)) return false;
  const value = equals as number;
  if (target.type === "choice") {
    return value >= 0 && value < target.options.length;
  }
  return value >= LIMITS.scale.min && value <= LIMITS.scale.max;
}
