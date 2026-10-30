import type { NotionRichText } from "./api-types.js";
import { type LinkLoss, vetLink } from "./link-address.js";

const NOTION_URL = "https://www.notion.so";
// Markdown without HTML (lens 4, 30.10): text that could open a link, a tag
// or an entity is escaped, inside links and outside them.
const MARKUP = /[\\[\]<>&]/g;

export function hasLink(part: NotionRichText): boolean {
  return linkOf(part) !== null;
}

// Rich text as markdown that keeps its links (role 1, 30.10): runs with the
// same address become one link, a page mention links to its Notion page.
// An address that fails vetLink leaves only the text and a loss.
export function richTextMarkdown(parts: readonly NotionRichText[]): {
  text: string;
  losses: LinkLoss[];
} {
  const runs: Array<{ href: string | null; text: string }> = [];
  for (const part of parts) {
    const href = linkOf(part);
    const last = runs.at(-1);
    if (last && last.href === href) last.text += part.plain_text;
    else runs.push({ href, text: part.plain_text });
  }

  const losses = new Set<LinkLoss>();
  let text = "";
  for (const run of runs) {
    const escaped = run.text.replace(MARKUP, "\\$&");
    const link = run.href === null ? null : vetLink(run.href);
    if (link === null) text += escaped;
    else if ("loss" in link) {
      losses.add(link.loss);
      text += escaped;
    } else text += `[${escaped}](${link.url})`;
  }
  return { text, losses: [...losses] };
}

function linkOf(part: NotionRichText): string | null {
  const page = part.type === "mention" && part.mention?.type === "page";
  const pageId = page ? part.mention?.page?.id : undefined;
  if (pageId) return `${NOTION_URL}/${pageId.replaceAll("-", "")}`;
  return part.href || null;
}
