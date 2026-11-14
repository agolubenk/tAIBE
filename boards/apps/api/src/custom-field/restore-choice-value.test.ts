import { describe, expect, it } from "vite-plus/test";
import { restoreChoiceValue } from "./restore-choice-value";

// Fake secrets assembled at runtime, so this file holds no key-shaped literal.
const join = (...parts: string[]) => parts.join("");
const SECRET = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const SECRET_2 = join("gh", "p_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2");
const MARK = "[REDACTED:api_key]";
const MISMATCH = { status: 409, code: "REDACTED_MARKERS_MISMATCH" };

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("restoreChoiceValue (TB-178)", () => {
  it("picks the one dropdown option that masks to the sent text", () => {
    expect(
      restoreChoiceValue(` ${MARK} `, "dropdown", ["prod", SECRET], null),
    ).toBe(SECRET);
    expect(
      restoreChoiceValue("prod", "dropdown", ["prod", SECRET], SECRET),
    ).toBe("prod");
  });

  it("keeps the task's dropdown choice when two options look the same, and refuses a new pick between them", () => {
    const options = [SECRET, SECRET_2];
    expect(restoreChoiceValue(MARK, "dropdown", options, SECRET_2)).toBe(
      SECRET_2,
    );
    expect(
      refusal(() => restoreChoiceValue(MARK, "dropdown", options, "x")),
    ).toMatchObject(MISMATCH);
    expect(
      refusal(() => restoreChoiceValue(MARK, "dropdown", ["prod"], null)),
    ).toMatchObject(MISMATCH);
  });

  it("restores each masked multiselect item, wherever the selection changed", () => {
    const options = ["prod", SECRET, "stage"];
    expect(
      restoreChoiceValue(
        JSON.stringify(["stage", MARK]),
        "multiselect",
        options,
        JSON.stringify([SECRET]),
      ),
    ).toBe(JSON.stringify(["stage", SECRET]));
    expect(
      restoreChoiceValue(
        JSON.stringify([MARK]),
        "multiselect",
        options,
        JSON.stringify(["prod"]),
      ),
    ).toBe(JSON.stringify([SECRET]));
  });

  it("sends back an unchanged multiselect with two look-alike options, keeps the current one beside a new pick, and refuses dropping one of two", () => {
    const options = [SECRET, SECRET_2, "prod"];
    const both = JSON.stringify([SECRET, SECRET_2]);
    expect(
      restoreChoiceValue(
        JSON.stringify([MARK, MARK]),
        "multiselect",
        options,
        both,
      ),
    ).toBe(both);
    expect(
      restoreChoiceValue(
        JSON.stringify([MARK, "prod"]),
        "multiselect",
        options,
        JSON.stringify([SECRET_2]),
      ),
    ).toBe(JSON.stringify([SECRET_2, "prod"]));
    expect(
      refusal(() =>
        restoreChoiceValue(
          JSON.stringify([MARK]),
          "multiselect",
          options,
          both,
        ),
      ),
    ).toMatchObject(MISMATCH);
  });

  it("leaves a value that is not a JSON array of strings to the field's own 400", () => {
    for (const value of [`[${MARK}`, JSON.stringify({ a: MARK }), "[1]"]) {
      expect(restoreChoiceValue(value, "multiselect", [SECRET], null)).toBe(
        value,
      );
    }
  });
});
