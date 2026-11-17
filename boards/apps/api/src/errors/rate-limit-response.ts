import { errorCodeForStatus } from "./error-code";

const FALLBACK_MESSAGE = "Too many requests";

type Body = { message?: unknown; code?: unknown };

function parseBody(text: string): Body | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Body)
      : null;
  } catch {
    return null;
  }
}

// better-auth sends the wait as X-Retry-After, which CORS does not expose to a
// browser on another origin. Retry-After is exposed (index.ts `exposeHeaders`),
// so the sign-in form can say «Повторите через N с» (TB-31 R-1, R-8).
function needsRetryAfter(headers: Headers): boolean {
  return headers.has("x-retry-after") && !headers.has("retry-after");
}

function copyRetryAfter(headers: Headers): Headers {
  const value = headers.get("x-retry-after");
  if (value && !headers.has("retry-after")) headers.set("retry-after", value);
  return headers;
}

export async function withJsonRateLimit(response: Response): Promise<Response> {
  if (response.status !== 429) return response;
  const text = await response.clone().text();
  const body = parseBody(text);
  if (typeof body?.message === "string" && typeof body.code === "string") {
    if (!needsRetryAfter(response.headers)) return response;
    return new Response(text, {
      status: 429,
      statusText: response.statusText,
      headers: copyRetryAfter(new Headers(response.headers)),
    });
  }
  const message =
    typeof body?.message === "string" ? body.message : body ? "" : text.trim();
  const headers = copyRetryAfter(new Headers(response.headers));
  headers.delete("content-type");
  headers.delete("content-length");
  return Response.json(
    { message: message || FALLBACK_MESSAGE, code: errorCodeForStatus(429) },
    { status: 429, headers },
  );
}
