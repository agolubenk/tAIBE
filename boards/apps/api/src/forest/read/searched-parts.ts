// A log's searchText glues its fields with "\n" and is cut at
// SEARCH_TEXT_CHARS; a caller with a token reads each field masked on its
// own (TB-143). Masked glued, a title that ends with a label
// ("Authorization: Bearer") took the first word of the description as its
// value, and the secret after the description's own label stayed open, so a
// right guess found the log and a wrong one did not (Claude #388 B1). So a
// match counts in each field on its own, and only in the part of it that
// searchText holds, where SQL found the query: else a word read past the cut
// would tell whether a secret before the cut holds it.
//
// Each part is a field, or the start of the field that the cut ends, and is
// found in searchText. A history entry is kept cut at HISTORY_CONTENT_CHARS,
// while searchText has the whole comment, so the next field is looked up
// after it, never at a fixed place. A field that is not found ends the
// parts: a match after it does not count.
export function searchedParts(searchText: string, fields: string[]): string[] {
  const parts: string[] = [];
  let at = 0;
  for (const field of fields) {
    const found = searchText.indexOf(field, at);
    if (found >= 0) {
      parts.push(field);
      at = found + field.length + 1;
      continue;
    }
    const rest = searchText.slice(at);
    if (rest && field.startsWith(rest)) parts.push(upToLastSpace(rest));
    break;
  }
  return parts;
}

// The cut can fall inside a secret, and redact does not know a secret without
// its end: a cut field is matched only up to its last whitespace (backend
// lens #388, R2). The rule runs on read, so logs felled before it are
// covered too.
function upToLastSpace(text: string) {
  const lastSpace = text.search(/\s\S*$/);
  return lastSpace < 0 ? "" : text.slice(0, lastSpace);
}
