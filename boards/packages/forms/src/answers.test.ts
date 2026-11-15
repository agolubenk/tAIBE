import { describe, expect, it } from "vite-plus/test";
import { type AnswerMap, validateAnswers, valueIssue } from "./answers";
import {
  type FormField,
  type FormTemplate,
  formTemplateSchema,
} from "./schema";

const form = (fields: unknown[]): FormTemplate =>
  formTemplateSchema.parse({ form: "probe", version: 2, title: "P", fields });

const check = (template: FormTemplate, answers: AnswerMap) =>
  validateAnswers(template, {
    form: template.form,
    version: template.version,
    answers: answers as Record<string, { v: unknown }>,
  });

const field = (raw: Record<string, unknown>): FormField =>
  form([{ id: "x", q: "?", ...raw }]).fields[0] as FormField;

const scale = { type: "scale", lo: "l", hi: "h" };
const choice = { type: "choice", options: ["a", "b"] };
const span = { type: "interval", kind: "number" };
const dates = { type: "interval", kind: "date" };
const grid = { type: "matrix", rows: ["r1", "r2"], cols: ["c1", "c2"] };

describe("valueIssue", () => {
  const cases: Array<[Record<string, unknown>, unknown, string | null]> = [
    [scale, 5, null],
    [scale, 0, "out_of_range"],
    [scale, 2.5, "wrong_type"],
    [{ type: "yesno" }, false, null],
    [{ type: "yesno" }, "true", "wrong_type"],
    [choice, 1, null],
    [choice, 2, "invalid_option"],
    [choice, "a", "wrong_type"],
    [span, [256, 768], null],
    [span, [768, 256], "invalid_interval"],
    [span, [1, null], "invalid_interval"],
    [span, [1, "2"], "wrong_type"],
    [span, [1, 2, 3], "wrong_type"],
    [dates, ["2026-11-06", "2026-11-20"], null],
    [dates, ["2026-11-20", "2026-11-06"], "invalid_interval"],
    [dates, ["2026-02-30", "2026-03-01"], "wrong_type"],
    [{ type: "input", kind: "number" }, 92, null],
    [{ type: "input", kind: "number" }, Number.NaN, "wrong_type"],
    [{ type: "input", kind: "text" }, "d4dev", null],
    [{ type: "input", kind: "text" }, "x".repeat(501), "too_long"],
    [{ type: "text" }, "x".repeat(10_000), null],
    [{ type: "text" }, "x".repeat(10_001), "too_long"],
    [{ type: "text" }, 7, "wrong_type"],
    [grid, [1, null], null],
    [grid, [1, 2], "invalid_option"],
    [grid, [1], "wrong_type"],
  ];

  it.each(cases)("%j with %j -> %s", (raw, value, code) => {
    expect(valueIssue(field(raw), value)).toBe(code);
  });
});

describe("validateAnswers", () => {
  const template = form([
    { id: "a", type: "yesno", q: "A?", required: true },
    {
      id: "b",
      type: "choice",
      q: "B?",
      options: ["x", "y"],
      showIf: { field: "a", equals: true },
    },
    {
      id: "c",
      type: "text",
      q: "C?",
      required: true,
      showIf: { field: "b", equals: 1 },
    },
    { id: "m", q: "M", required: true, ...grid },
  ]);

  it("refuses a set for another version or form as a whole", () => {
    const old = { form: "probe", version: 1, answers: {} };
    expect(validateAnswers(template, old)).toEqual({
      ok: false,
      issues: [{ fieldId: null, code: "version_mismatch" }],
      answers: {},
    });
    const other = { form: "other", version: 2, answers: {} };
    expect(validateAnswers(template, other).issues).toEqual([
      { fieldId: null, code: "version_mismatch" },
    ]);
  });

  it("asks only shown required fields, a whole matrix included", () => {
    expect(check(template, {}).issues).toEqual([
      { fieldId: "a", code: "required" },
      { fieldId: "m", code: "required" },
    ]);
    const partial = { a: { v: true }, b: { v: 1 }, m: { v: [0, null] } };
    expect(check(template, partial).issues).toEqual([
      { fieldId: "c", code: "required" },
      { fieldId: "m", code: "required" },
    ]);
  });

  it("drops answers to hidden fields and names unknown ones", () => {
    const result = check(template, {
      a: { v: false },
      b: { v: 9 },
      c: { v: "" },
      m: { v: [0, 1] },
      z: { v: 1 },
    });
    expect(result.issues).toEqual([{ fieldId: "z", code: "unknown_field" }]);
    expect(Object.keys(result.answers)).toEqual(["a", "m"]);
  });

  it("keeps a note without a value and checks its length", () => {
    const ok = check(template, {
      a: { v: true },
      b: { v: null, note: "later" },
      m: { v: [0, 1] },
    });
    expect(ok.ok).toBe(true);
    expect(ok.answers.b).toEqual({ v: null, note: "later" });

    const long = check(template, {
      a: { v: true, note: "n".repeat(2001) },
      m: { v: [0, 1] },
    });
    expect(long.issues).toEqual([{ fieldId: "a", code: "too_long" }]);
  });

  // Autosave: yes -> no -> yes on a parent must not lose the child's answer.
  it("keeps and checks hidden answers in a draft, no required", () => {
    const doc = (answers: AnswerMap) => ({
      form: template.form,
      version: template.version,
      answers: answers as Record<string, { v: unknown }>,
    });
    const hidden = { a: { v: false }, b: { v: 1 }, c: { v: "kept" } };

    const draft = validateAnswers(template, doc(hidden), { draft: true });
    expect(draft).toEqual({ ok: true, issues: [], answers: hidden });

    const bad = validateAnswers(template, doc({ b: { v: 9 } }), {
      draft: true,
    });
    expect(bad.issues).toEqual([{ fieldId: "b", code: "invalid_option" }]);

    const submit = validateAnswers(template, doc(hidden));
    expect(Object.keys(submit.answers)).toEqual(["a"]);
  });

  it("takes a half-filled required matrix in a draft, not on submit", () => {
    const half = {
      form: template.form,
      version: template.version,
      answers: { a: { v: false }, m: { v: [0, null] } },
    };

    expect(validateAnswers(template, half, { draft: true }).ok).toBe(true);
    expect(validateAnswers(template, half).issues).toEqual([
      { fieldId: "m", code: "required" },
    ]);
  });
});
