import type { NotionRichText } from "./api-types.js";

const SIGNED =
  /X-Amz-Signature|prod-files-secure|file\.notion\.so\/f\/|secure\.notion-static\.com/i;
const SAFE_SCHEME = /^(?:https?:|mailto:)/i;
const NOTION_URL = "https://www.notion.so";

export function hasLink(part: NotionRichText): boolean {
  return linkOf(part) !== null;
}

// Rich text as markdown that keeps its links (role 1, 30.10): runs with the
// same address become one link, a page mention links to its Notion page.
// A signed file address or another scheme leaves only the text and a loss.
// Text outside links stays verbatim, so a value without links reads as before.
export function richTextMarkdown(parts: readonly NotionRichText[]): {
  text: string;
  losses: Array<"signed" | "scheme">;
} {
  const runs: Array<{ href: string | null; text: string }> = [];
  for (const part of parts) {
    const href = linkOf(part);
    const last = runs.at(-1);
    if (last && last.href === href) last.text += part.plain_text;
    else runs.push({ href, text: part.plain_text });
  }

  const losses = new Set<"signed" | "scheme">();
  let text = "";
  for (const run of runs) {
    if (run.href === null) text += run.text;
    else if (SIGNED.test(run.href)) {
      losses.add("signed");
      text += run.text;
    } else if (!SAFE_SCHEME.test(run.href)) {
      losses.add("scheme");
      text += run.text;
    } else {
      text += `[${escapeLinkText(run.text)}](${escapeLinkUrl(run.href)})`;
    }
  }
  return { text, losses: [...losses] };
}

function linkOf(part: NotionRichText): string | null {
  const page = part.type === "mention" && part.mention?.type === "page";
  const pageId = page ? part.mention?.page?.id : undefined;
  if (pageId) return `${NOTION_URL}/${pageId.replaceAll("-", "")}`;
  if (!part.href) return null;
  // Notion writes links to its own pages relative to the workspace.
  return part.href.startsWith("/") ? `${NOTION_URL}${part.href}` : part.href;
}

function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&");
}

function escapeLinkUrl(url: string): string {
  return url.replace(/[\\()]/g, "\\$&").replace(/ /g, "%20");
}
