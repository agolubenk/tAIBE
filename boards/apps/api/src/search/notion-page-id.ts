// A Notion page id comes as 32 hex digits, with the 8-4-4-4-12 dashes or
// without them, or at the end of a Notion link (`…/Title-<id>?pvs=4`).
// card_meta keeps the dashed lowercase form that the Notion API returns.
const NOTION_PAGE_ID =
  /(?:^|[^0-9a-f])([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?:[?#]\S*)?$/i;

export function notionPageIdOf(query: string): string | null {
  const match = query.trim().match(NOTION_PAGE_ID);
  return match ? match.slice(1, 6).join("-").toLowerCase() : null;
}
