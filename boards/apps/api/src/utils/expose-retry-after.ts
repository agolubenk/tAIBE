import { createMiddleware } from "hono/factory";

/**
 * better-auth sends the wait of a 429 as X-Retry-After, which CORS does not
 * expose to a browser on another origin. Retry-After is exposed (index.ts
 * `exposeHeaders`), so the sign-in form can say «Повторите через N с»
 * (TB-31 R-1, R-8).
 *
 * Register it before applyApiKeyHeaders: it then runs after it, so an API-key
 * response first gets its own Retry-After and a private Cache-Control there.
 */
export const exposeRetryAfter = createMiddleware(async (c, next) => {
  await next();
  if (c.res.status !== 429 || c.res.headers.has("Retry-After")) return;
  const value = c.res.headers.get("X-Retry-After");
  if (value) c.header("Retry-After", value);
});
