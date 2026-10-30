import type { ImportedTask } from "@kaneo/importers";

// b13 В′: Notion fields with no place on the card ride on the body's last
// line, one JSON object behind a fixed marker. The reconciliation reads it
// back with the same pattern, so its shape is a contract: blank line before
// it (or nothing, on an empty body), compact JSON, keys in schema order.
export const NOTION_FOOTER_FIELDS =
  /^(task id|bug id|backlog id|очередь|council readiness)$/i;
export const BACKLOG_ID_FIELD = /^backlog\s*id$/i;

const MARKER = "Notion: ";
const FOOTER_LINE = /(?:^|\n\n)Notion: (\{.*\})[ \t]*$/;

export type NotionFooter = Readonly<Record<string, string | number>>;

// Backlog ID stays in the footer only on a card that could not keep it in
// card_meta (another card holds the same ID).
export function footerOf(task: ImportedTask, keepsBacklogId: boolean) {
  return Object.fromEntries(
    Object.entries(task.footer ?? {}).filter(
      ([name]) => !(keepsBacklogId && BACKLOG_ID_FIELD.test(name)),
    ),
  );
}

// Strips an earlier footer first, so writing the same fields twice gives the
// same body byte for byte.
export function withNotionFooter(body: string, footer: NotionFooter): string {
  const text = body.replace(FOOTER_LINE, "").trimEnd();
  if (Object.keys(footer).length === 0) return text;
  const line = `${MARKER}${JSON.stringify(footer)}`;
  return text ? `${text}\n\n${line}` : line;
}

export function readNotionFooter(body: string): NotionFooter | null {
  const match = FOOTER_LINE.exec(body);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as NotionFooter;
  } catch {
    return null;
  }
}
