import { readFileSync } from "node:fs";
import { formTemplateSchema } from "./schema";

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

/** The grill questionnaire as a template (53 fields, no display rules). */
export const grillTemplate = () =>
  formTemplateSchema.parse(read("../fixtures/t-boards-grill.form.json"));

/** The owner's answers of 26.10, as the grill exported them. */
export const grillAnswers = () =>
  read("../../../docs/archive/t-boards-grill-answers.json") as {
    form: string;
    version: number;
    answered: number;
    total: number;
    answers: Array<{
      id: string;
      q: string;
      v: unknown;
      answer: unknown;
      note: string;
    }>;
  };
