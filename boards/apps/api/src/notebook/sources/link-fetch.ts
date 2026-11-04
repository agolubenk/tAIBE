import type { FetchLike } from "@kaneo/importers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "../../errors/api-error";
import { publicDestinationFetch } from "../../import/destination-fetch";
import {
  createGuardedFetch,
  GuardError,
  type GuardReason,
} from "../../import/guarded-fetch";

// The HTML of a long article is well under this; the text cut from it must
// still fit SOURCE_TEXT_MAX.
export const LINK_MAX_BYTES = 2 * 1024 * 1024;
export const LINK_TIMEOUT_MS = 10_000;
export const LINK_MIME_TYPES = [
  "text/html",
  "text/plain",
  "text/markdown",
] as const;
export type LinkMime = (typeof LINK_MIME_TYPES)[number];
export type FetchedLink = { mime: LinkMime; body: string };

type FetchLinkOptions = {
  baseFetch?: FetchLike;
  maxBytes?: number;
  timeoutMs?: number;
};

const ACCEPT = "text/html, text/markdown, text/plain;q=0.9";

export function linkRefusal(
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  return new ApiError(status, { code, message });
}

const GUARD_REFUSALS: Record<GuardReason, [ContentfulStatusCode, string]> = {
  "invalid-url": [400, "LINK_INVALID_URL"],
  protocol: [400, "LINK_NOT_HTTPS"],
  destination: [422, "LINK_PRIVATE_DESTINATION"],
  unresolved: [422, "LINK_UNREACHABLE"],
  redirects: [422, "LINK_TOO_MANY_REDIRECTS"],
};

const timedOut = () =>
  linkRefusal(422, "LINK_TIMEOUT", "The page did not answer in time.");
const tooLarge = (maxBytes: number) =>
  linkRefusal(
    413,
    "LINK_TOO_LARGE",
    `The page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`,
  );

function contentType(header: string | null) {
  const [type = "", ...params] = (header ?? "").split(";");
  const charset = params
    .map((param) => param.trim().match(/^charset="?([^";]+)"?$/i)?.[1])
    .find(Boolean);
  return { mime: type.trim().toLowerCase(), charset };
}

function isLinkMime(mime: string): mime is LinkMime {
  return (LINK_MIME_TYPES as readonly string[]).includes(mime);
}

function decode(bytes: Uint8Array, charset: string | undefined) {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function toRefusal(error: unknown, timeout: boolean) {
  if (error instanceof ApiError) return error;
  if (timeout) return timedOut();
  if (error instanceof GuardError) {
    const [status, code] = GUARD_REFUSALS[error.reason];
    return linkRefusal(status, code, error.message);
  }
  return linkRefusal(422, "LINK_UNREACHABLE", "The page could not be reached.");
}

// One explicit fetch a member asked for: https on every hop, a public address
// checked before the request and again at connect time, a byte cap and one
// deadline over DNS, redirects and the body.
export async function fetchLink(
  url: URL,
  {
    baseFetch = publicDestinationFetch,
    maxBytes = LINK_MAX_BYTES,
    timeoutMs = LINK_TIMEOUT_MS,
  }: FetchLinkOptions = {},
): Promise<FetchedLink> {
  const controller = new AbortController();
  // Links never honour KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS. That switch
  // is for webhooks an admin points at a trusted intranet; a link is any URL a
  // member pastes, and on the VPS the API sees the tunnel, Postgres and Redis.
  const guard = createGuardedFetch("Link", {
    baseFetch,
    cancelSignal: controller.signal,
    alwaysPublic: true,
    httpsOnly: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timedOut());
    }, timeoutMs);
  });

  const read = async (): Promise<FetchedLink> => {
    const response = await guard.fetch(url.href, {
      headers: { accept: ACCEPT, "user-agent": "tAI-Boards notebook" },
      signal: controller.signal,
    });
    reader = response.body?.getReader();
    if (!response.ok) {
      throw linkRefusal(
        422,
        "LINK_UPSTREAM_STATUS",
        `The page answered with status ${response.status}.`,
      );
    }
    const { mime, charset } = contentType(response.headers.get("content-type"));
    if (mime === "application/pdf") {
      throw linkRefusal(
        415,
        "LINK_PDF_UNSUPPORTED",
        "PDF links are not supported yet.",
      );
    }
    if (!isLinkMime(mime)) {
      throw linkRefusal(
        415,
        "LINK_CONTENT_TYPE",
        `Only HTML, Markdown and plain text pages can be added, not ${mime || "an unknown type"}.`,
      );
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      throw tooLarge(maxBytes);
    }
    // Fixed storage also bounds overhead when a stream uses tiny chunks.
    const bytes = new Uint8Array(maxBytes);
    let size = 0;
    for (;;) {
      if (!reader) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) throw tooLarge(maxBytes);
      bytes.set(value, size);
      size += value.byteLength;
    }
    return { mime, body: decode(bytes.subarray(0, size), charset) };
  };

  try {
    return await Promise.race([deadline, read()]);
  } catch (error) {
    throw toRefusal(error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}
