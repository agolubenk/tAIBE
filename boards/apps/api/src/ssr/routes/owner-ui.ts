import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";

// tAI-Boards SSR (spec approved 31.10): only the owner's browser session
// approves, rejects and rolls back (RU-6, RU-7) — a bearer token of any kind
// is an agent and is refused on those routes.
export function assertOwnerUi(headers: Headers) {
  if (headers.has("authorization") || headers.has("x-api-key")) {
    throw new HTTPException(403, {
      message: "Owner decisions are made from the owner's browser session only",
    });
  }
}

// The same check as route middleware, so an agent is refused before the body
// is validated and learns nothing from validation errors.
export function ownerUiOnly() {
  return async (c: Context, next: Next) => {
    assertOwnerUi(c.req.raw.headers);
    return next();
  };
}
