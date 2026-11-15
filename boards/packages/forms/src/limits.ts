// The size limits of a template and its answers. No zod here: the answer
// checks import only this file, so a web chunk with the checks does not pull
// the zod schemas in (TB-173, #357 bundle).

export const LIMITS = {
  fields: 200,
  id: 40,
  title: 200,
  q: 500,
  help: 2000,
  option: 500,
  options: { min: 2, max: 5 },
  rows: 30,
  cols: { min: 2, max: 6 },
  label: 200,
  unit: 40,
  placeholder: 2000,
  scale: { min: 1, max: 5 },
  inputText: 500,
  text: 10_000,
  note: 2000,
} as const;
