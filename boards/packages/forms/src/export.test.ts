import { describe, expect, it } from "vite-plus/test";
import { validateAnswers } from "./answers";
import { exportAnswers, humanAnswer } from "./export";
import { grillAnswers, grillTemplate } from "./fixtures.test-helper";
import { formTemplateSchema } from "./schema";
import { visibleFieldIds } from "./show-if";

describe("grill round trip (TB-173 acceptance)", () => {
  it("exports the owner's grill answers equal by q and answer", () => {
    const template = grillTemplate();
    const archived = grillAnswers();
    const doc = {
      form: archived.form,
      version: archived.version,
      answers: Object.fromEntries(
        archived.answers.map((entry) => [
          entry.id,
          { v: entry.v, note: entry.note },
        ]),
      ),
    };

    const check = validateAnswers(template, doc);
    expect(check.issues).toEqual([]);

    const exported = exportAnswers(template, check, {
      submitted: true,
      at: "2026-10-26T21:36:31.271Z",
    });
    expect(exported).toMatchObject({
      form: "t-boards-grill",
      version: 1,
      answered: archived.answered,
      total: archived.total,
    });
    expect(exported.answers.map(({ q, answer }) => ({ q, answer }))).toEqual(
      archived.answers.map(({ q, answer }) => ({ q, answer })),
    );
    expect(exported.answers).toEqual(archived.answers);
  });
});

describe("humanAnswer", () => {
  const [yesno, choice, matrix] = formTemplateSchema.parse({
    form: "probe",
    version: 1,
    title: "P",
    fields: [
      { id: "y", type: "yesno", q: "Y?" },
      { id: "c", type: "choice", q: "C?", options: ["one", "two"] },
      { id: "m", type: "matrix", q: "M", rows: ["r1", "r2"], cols: ["a", "b"] },
    ],
  }).fields;
  if (!yesno || !choice || !matrix) throw new Error("fixture");
  const en = { yes: "yes", no: "no", empty: "-" };

  it("takes the labels from the caller; the grill's are the default", () => {
    expect(humanAnswer(yesno, true)).toBe("да");
    expect(humanAnswer(yesno, false, en)).toBe("no");
    expect(humanAnswer(choice, 1)).toBe("two");
    expect(humanAnswer(matrix, [1, null], en)).toEqual(["r1: b", "r2: -"]);
    expect(humanAnswer(matrix, [null, 0])).toEqual(["r1: —", "r2: a"]);
    expect(humanAnswer(choice, null)).toBeNull();
  });
});

describe("display rule", () => {
  const template = formTemplateSchema.parse({
    form: "probe",
    version: 1,
    title: "P",
    fields: [
      { id: "c", type: "text", q: "C?", showIf: { field: "b", equals: 1 } },
      { id: "a", type: "yesno", q: "A?" },
      {
        id: "b",
        type: "choice",
        q: "B?",
        options: ["x", "y"],
        showIf: { field: "a", equals: true },
      },
    ],
  });
  const visible = (answers: Record<string, { v: unknown }>) =>
    [...visibleFieldIds(template, answers)].sort();

  it("shows a field if its rule's answer matches and is shown", () => {
    expect(visible({})).toEqual(["a"]);
    expect(visible({ a: { v: true } })).toEqual(["a", "b"]);
    expect(visible({ a: { v: true }, b: { v: 1 } })).toEqual(["a", "b", "c"]);
    expect(visible({ a: { v: false }, b: { v: 1 } })).toEqual(["a"]);
    expect(visible({ a: { v: "true" } })).toEqual(["a"]);
  });

  it("leaves hidden fields out of the export and out of the total", () => {
    const exported = exportAnswers(
      template,
      { answers: { a: { v: false }, b: { v: 1 }, c: { v: "kept?" } } },
      { submitted: false, at: "2026-11-15T00:00:00.000Z" },
    );
    expect(exported.answers.map((entry) => entry.id)).toEqual(["a"]);
    expect(exported).toMatchObject({ answered: 1, total: 1 });
  });
});
