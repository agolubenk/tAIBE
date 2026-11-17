// The API answers these refusals with stable codes; the rest keep its message.
export const SOURCE_ERROR_CODES = [
  "LINK_INVALID_URL",
  "LINK_NOT_HTTPS",
  "LINK_PRIVATE_DESTINATION",
  "LINK_UNREACHABLE",
  "LINK_TOO_MANY_REDIRECTS",
  "LINK_TIMEOUT",
  "LINK_UPSTREAM_STATUS",
  "LINK_TOO_LARGE",
  "LINK_CONTENT_TYPE",
  "LINK_PDF_UNSUPPORTED",
  "LINK_EMPTY",
  "LINK_BUSY",
  "PR_INVALID_URL",
  "PR_REPO_NOT_LINKED",
  "PR_NOT_FOUND",
  "GITHUB_APP_NOT_CONFIGURED",
  "GITHUB_UNAVAILABLE",
  "GITHUB_NO_ACCESS",
  "SOURCE_TOO_MANY_CHUNKS",
] as const;
export type SourceErrorCode = (typeof SOURCE_ERROR_CODES)[number];

export function sourceErrorCode(error: unknown): SourceErrorCode | null {
  const code = (error as { code?: unknown } | null)?.code;
  return (SOURCE_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as SourceErrorCode)
    : null;
}
