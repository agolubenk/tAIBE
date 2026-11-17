import { z } from "zod";
import { id } from "./forest/request.js";
import type { ToolClient } from "./register.js";
import { type RegisterTool, run } from "./register-tool.js";

// TB-173 (R-027, F-24-1): the owner and agents create forms and attach them to
// cards; a person answers in the web app, an agent only reads the answers.
// The input names the common keys only: the full template schema of
// @kaneo/forms is 10.4 KB of JSON schema, and tools/list would carry it into
// every session. The API checks the template and names the wrong field.
// The types and limits are those of @kaneo/forms (FIELD_TYPES, LIMITS);
// apps/api/src/form/mcp-form-tools.test.ts fails when they part.
export const FORM_FIELD_TYPES = [
  "scale",
  "yesno",
  "choice",
  "interval",
  "input",
  "text",
  "matrix",
] as const;

export const FORM_LIMITS = {
  fields: 200,
  id: 40,
  title: 200,
  q: 500,
  options: { min: 2, max: 5 },
  rows: 30,
  cols: { min: 2, max: 6 },
} as const;
const LIMITS = FORM_LIMITS;
const FIELD_HELP = [
  "Every field: id (unique, letters, digits, _ and -, up to 40), type, q (the question), optional help, required, showIf {field, equals}: shown only if that choice (option index), yes/no (boolean) or scale (1..5) answer equals `equals`.",
  "By type: scale — lo, hi (labels of 1 and 5); yesno — nothing more;",
  `choice — options (${LIMITS.options.min} to ${LIMITS.options.max}; the answer is the index);`,
  "interval — kind number|date, unit?; input — kind number|text, unit?, placeholder?; text — placeholder?;",
  `matrix — rows (up to ${LIMITS.rows}), cols (${LIMITS.cols.min} to ${LIMITS.cols.max}).`,
  "All texts are plain text, never HTML or markdown.",
].join(" ");

const field = z
  .looseObject({
    id: z.string().trim().min(1).max(LIMITS.id),
    type: z.enum(FORM_FIELD_TYPES),
    q: z.string().trim().min(1).max(LIMITS.q),
  })
  .describe(FIELD_HELP);

const template = z.object({
  form: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
    .describe("The template's slug, e.g. «release-check»."),
  version: z
    .number()
    .int()
    .min(1)
    .describe(
      "Answers name this version; changed fields or options need a new one.",
    ),
  title: z.string().trim().min(1).max(LIMITS.title),
  fields: z.array(field).min(1).max(LIMITS.fields),
});

export function registerFormTools(
  registerTool: RegisterTool,
  client: ToolClient,
) {
  registerTool(
    "create_form",
    {
      description:
        "Create a form template in a workspace (TB-173): a slug, a version and up to 200 fields of seven types. A slug with the same version is refused (409 TEMPLATE_VERSION_EXISTS); change fields under a new version. Then attach it to a card with attach_form.",
      inputSchema: z.object({ workspaceId: id, template }),
    },
    ({ workspaceId, template: body }) =>
      run(() =>
        client.json(`/api/form/template/${encodeURIComponent(workspaceId)}`, {
          method: "POST",
          body: JSON.stringify({ template: body }),
        }),
      ),
  );

  // An agent write on a card: the lease headers come from the arguments
  // (agent-write.ts), and the API refuses an agent without a live lease.
  registerTool(
    "attach_form",
    {
      description:
        "Attach a form template of the card's workspace to a card. Take the card's lease first (forest_acquire_lease) and send its fencingToken. One template goes on a card once (409 FORM_ALREADY_ATTACHED). The owner answers it in the web app; read the answers with get_form_responses.",
      inputSchema: z.object({ taskId: id, templateId: id }),
    },
    ({ taskId, templateId }, writeClient) =>
      run(() =>
        writeClient.json(`/api/form/task/${encodeURIComponent(taskId)}`, {
          method: "POST",
          body: JSON.stringify({ templateId }),
        }),
      ),
  );

  registerTool(
    "get_form_responses",
    {
      description:
        "Read the forms on a card: each with its template, status (draft or submitted), submittedAt and the answers keyed by field id ({ v, note? }). Secrets in the answers come masked. An agent cannot answer for the owner (N-004).",
      inputSchema: z.object({ taskId: id }),
    },
    ({ taskId }) =>
      run(() => client.json(`/api/form/task/${encodeURIComponent(taskId)}`)),
  );
}
