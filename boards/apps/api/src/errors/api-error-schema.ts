import { z } from "@hono/zod-openapi";
import { REAUTH_METHODS } from "@kaneo/permissions";

export const apiErrorSchema = z
  .object({
    message: z.string().openapi({
      description: "Human-readable description of the error.",
      example: "Task not found",
    }),
    code: z.string().openapi({
      description:
        "Stable UPPER_SNAKE_CASE code. Derived from the status unless a more specific code applies, such as VALIDATION_ERROR or MISSING_PERMISSION.",
      example: "NOT_FOUND",
    }),
    issues: z
      .array(
        z.object({
          path: z.string().openapi({
            description:
              "Dotted path to the invalid input, prefixed with the request part (body, query, params, header).",
            example: "body.title",
          }),
          message: z.string().openapi({ example: "Required" }),
        }),
      )
      .optional()
      .openapi({
        description: "Every validation issue, for VALIDATION_ERROR.",
      }),
    missingPermissions: z
      .array(z.string())
      .optional()
      .openapi({
        description:
          "Permissions the caller lacks for this route, as resource:action, for MISSING_PERMISSION and API_KEY_SCOPE.",
        example: ["task:update"],
      }),
    target: z.string().optional().openapi({
      description:
        "The one entry the request named that was refused, such as an import source's database ID, when the request named several.",
      example: "1a2b3c4d5e6f40718293a4b5c6d7e8f9",
    }),
  })
  .openapi("ApiError");

// TB-31 R-5: SESSION_NOT_FRESH on an API route carries the same fields as the
// guard's reply under /api/auth (`ReauthErrorBody` in @kaneo/permissions).
export const reauthErrorSchema = apiErrorSchema
  .extend({
    methods: z
      .array(z.enum(REAUTH_METHODS))
      .optional()
      .openapi({
        description:
          "On SESSION_NOT_FRESH: the ways this person can confirm it is them now. Empty when impersonated.",
        example: ["password", "emailCode"],
      }),
    impersonated: z.literal(true).optional().openapi({
      description:
        "On SESSION_NOT_FRESH of an impersonated session: no confirmation is possible.",
    }),
  })
  .openapi("ReauthError");
