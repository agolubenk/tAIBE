import { describe, expect, it } from "vite-plus/test";
import { grillTemplate } from "./fixtures.test-helper";
import { type FormField, formTemplateSchema } from "./schema";
import { findShowIfCycle } from "./show-if";

const template = (fields: unknown[]) => ({
  form: "probe",
  version: 1,
  title: "Probe",
  fields,
});

const codes = (fields: unknown[]) => {
  const result = formTemplateSchema.safeParse(template(fields));
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
};

const yesno = { id: "a", type: "yesno", q: "A?" };
const choice = {
  id: "b",
  type: "choice",
  q: "B?",
  options: ["one", "two", "three"],
};

describe("form template schema", () => {
  it("takes the grill questionnaire: 53 fields of the seven types", () => {
    const grill = grillTemplate();
    const count = (type: string) =>
      grill.fields.filter((field) => field.type === type).length;
    const types = ["choice", "yesno", "matrix", "interval", "text", "input"];

    expect(grill.fields).toHaveLength(53);
    expect([...types, "scale"].map(count)).toEqual([19, 10, 9, 5, 5, 3, 2]);
  });

  it("refuses unknown keys, bad sizes and bad ids", () => {
    const six = ["1", "2", "3", "4", "5", "6"];
    const oneColumn = { id: "m", type: "matrix", q: "M", rows: ["r"] };
    const many = Array.from({ length: 201 }, (_, i) => ({
      ...yesno,
      id: `f${i}`,
    }));

    expect(codes([{ ...yesno, why: "x" }])).not.toEqual([]);
    expect(codes([{ ...choice, options: six }])).not.toEqual([]);
    expect(codes([{ ...oneColumn, cols: ["c"] }])).not.toEqual([]);
    expect(codes([{ ...yesno, id: "a b" }])).not.toEqual([]);
    expect(codes([{ ...yesno, q: "   " }])).not.toEqual([]);
    expect(codes(many)).not.toEqual([]);
  });

  it("names a duplicate id and each rule fault by a code", () => {
    expect(codes([yesno, { ...choice, id: "a" }])).toEqual([
      { path: "fields.1.id", message: "duplicate_id" },
    ]);

    const text = { id: "t", type: "text", q: "T" };
    const scale = { id: "s", type: "scale", q: "S", lo: "low", hi: "high" };
    const rule = (id: string, field: string, equals: unknown) => ({
      ...yesno,
      id,
      showIf: { field, equals },
    });
    const issues = codes([
      yesno,
      choice,
      text,
      rule("c", "nope", true),
      rule("d", "t", "x"),
      rule("e", "b", 3),
      rule("f", "a", "true"),
      scale,
      rule("g", "s", 6),
    ]);

    expect(issues).toEqual([
      { path: "fields.3.showIf.field", message: "unknown_target" },
      { path: "fields.4.showIf.field", message: "target_type" },
      { path: "fields.5.showIf.equals", message: "invalid_equals" },
      { path: "fields.6.showIf.equals", message: "invalid_equals" },
      { path: "fields.8.showIf.equals", message: "invalid_equals" },
    ]);
  });

  it("takes a rule on a later field and refuses a cycle with its path", () => {
    const onB = { ...yesno, showIf: { field: "b", equals: 0 } };
    const onA = { ...choice, showIf: { field: "a", equals: true } };
    expect(codes([onB, choice])).toEqual([]);

    const result = formTemplateSchema.safeParse(template([onB, onA]));

    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([
      {
        message: "cycle",
        path: ["fields", 0, "showIf"],
        params: { code: "cycle", ids: ["a", "b", "a"] },
      },
    ]);
  });
});

describe("findShowIfCycle", () => {
  const chain = (length: number): FormField[] =>
    Array.from({ length }, (_, i) => ({
      id: `f${i}`,
      type: "yesno" as const,
      q: "?",
      ...(i > 0 ? { showIf: { field: `f${i - 1}`, equals: true } } : {}),
    }));

  it("finds a field that shows itself", () => {
    const self = { id: "a", showIf: { field: "a", equals: true } };
    expect(findShowIfCycle([self])).toEqual(["a", "a"]);
  });

  it("finds a cycle closing a long chain, none in a plain one", () => {
    const fields = chain(200);
    expect(findShowIfCycle(fields)).toBeNull();

    const first = fields[0];
    if (!first) throw new Error("fixture");
    fields[0] = { ...first, showIf: { field: "f199", equals: true } };
    const cycle = findShowIfCycle(fields);
    expect(cycle).toHaveLength(201);
    expect(cycle?.[0]).toBe(cycle?.[200]);
  });

  it("ignores a rule on an unknown field: the schema reports it", () => {
    const orphan = { id: "a", showIf: { field: "x", equals: true } };
    expect(findShowIfCycle([orphan])).toBeNull();
  });
});
