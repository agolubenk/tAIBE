const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

// TB-87. Without CORS_ORIGINS a development API answers with credentials only
// to pages served from this machine; a page of another site cannot read
// session answers from a local stand or a misbuilt image.
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === origin &&
    LOOPBACK_HOSTS.has(url.hostname)
  );
}
