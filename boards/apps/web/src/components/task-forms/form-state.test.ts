import { describe, expect, it } from "vite-plus/test";
import { formProgress, issuesByField, withAnswer } from "./form-state";
import { sevenTypesTemplate as template } from "./form-test-template";

describe("form state (TB-173)", () => {
  it("counts only shown fields in the progress", () => {
    // 8 fields, "size" is hidden until "team" is yes.
    expect(formProgress(template, {})).toEqual({ answered: 0, total: 7 });
    expect(
      formProgress(template, { team: { v: true }, size: { v: 3 } }),
    ).toEqual({ answered: 2, total: 8 });
    // An answer to a hidden field stays in the map but does not count.
    expect(
      formProgress(template, { team: { v: false }, size: { v: 3 } }),
    ).toEqual({ answered: 1, total: 7 });
  });

  it("does not count an interval or a matrix with no part filled", () => {
    expect(
      formProgress(template, {
        dates: { v: [null, null] },
        grid: { v: [null, null] },
      }).answered,
    ).toBe(0);
    expect(formProgress(template, { grid: { v: [0, null] } }).answered).toBe(1);
  });

  it("removes an answer with no value and no note", () => {
    const answers = withAnswer({}, template, "name", { v: "Ann" });
    expect(answers).toEqual({ name: { v: "Ann" } });
    expect(withAnswer(answers, template, "name", { v: "" })).toEqual({});
    // A note keeps an empty answer; a blank note does not.
    const noted = withAnswer(answers, template, "name", { note: "later" });
    expect(withAnswer(noted, template, "name", { v: "" })).toEqual({
      name: { v: "", note: "later" },
    });
    expect(
      withAnswer({}, template, "name", { v: null, note: "   " }),
    ).toEqual({});
  });

  it("ignores a field that is not in the template", () => {
    const answers = { name: { v: "Ann" } };
    expect(withAnswer(answers, template, "nope", { v: 1 })).toBe(answers);
  });

  it("keeps the first issue of each field and the whole-form issue", () => {
    const byField = issuesByField([
      { fieldId: "name", code: "required" },
      { fieldId: "name", code: "too_long" },
      { fieldId: null, code: "version_mismatch" },
    ]);
    expect(byField.get("name")).toBe("required");
    expect(byField.get(null)).toBe("version_mismatch");
  });
});
