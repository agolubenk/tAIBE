/**
 * TB-191: the stored text of one masked match page, at least one row. Redact
 * reads 1 MiB of text dense with secrets in about 25 ms.
 */
export const MASKED_MATCH_PAGE_BYTES = 1024 * 1024;

/**
 * The first rows of the window, up to `size` rows and the byte budget, and
 * at least one row. The cut depends only on the rows, not on the query.
 */
export function maskedMatchPage<T extends { bytes: number }>(
  window: T[],
  size: number,
): T[] {
  let bytes = 0;
  let end = 0;
  while (end < Math.min(window.length, size)) {
    bytes += window[end]?.bytes ?? 0;
    if (end > 0 && bytes > MASKED_MATCH_PAGE_BYTES) break;
    end += 1;
  }
  return window.slice(0, end);
}
