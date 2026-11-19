// Search params of the workspace search page: `q` is the query, kept only when
// it has text so an empty search leaves a clean address. The router parses
// `?q=227` as a number, so numbers come back as text.
export function parseSearchQuery(search: Record<string, unknown>): {
  q?: string;
} {
  const raw = search.q;
  const q =
    typeof raw === "string"
      ? raw
      : typeof raw === "number" && Number.isFinite(raw)
        ? String(raw)
        : undefined;
  return q?.trim() ? { q } : {};
}
