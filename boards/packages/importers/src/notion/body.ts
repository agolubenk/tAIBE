import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import {
  blockPayload,
  type NotionBlock,
  type NotionRichText,
} from "./api-types.js";

let service: TurndownService | undefined;

// Blocks are rendered to a small HTML subset and handed to turndown, the same
// converter the other importers use; there is no block-to-Markdown logic here.
export function blocksToMarkdown(blocks: NotionBlock[]): string {
  if (blocks.length === 0) return "";
  service ??= createService();
  return service
    .turndown(blocksToHtml(blocks))
    .replace(/\n{3,}/g, "\n\n")
    .replace(STUB_ESCAPED, "[$1]")
    .trim();
}

export function blocksToHtml(blocks: NotionBlock[]): string {
  return renderBlocks(blocks);
}

// A file Notion hosts is a signed link that expires within the hour: the card
// says what was there instead of keeping a dead link (TB-20 moves the files).
export const FILE_STUB = (type: string) =>
  `[файл Notion не перенесён: ${type}]`;

// Turndown escapes the brackets; the stub reads the same in every body.
const STUB_ESCAPED = /\\\[(файл Notion не перенесён: [a-z_]+)\\\]/g;

const FILE_BLOCKS = new Set(["image", "file", "pdf", "video", "audio"]);
// Rendered through their children or their table; nothing of their own is lost.
const CONTAINER_BLOCKS = new Set([
  "column_list",
  "column",
  "synced_block",
  "table_row",
]);
const RENDERED_BLOCKS = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
  "divider",
  "bookmark",
  "link_preview",
  "embed",
  "child_page",
  "table",
  "equation",
  ...FILE_BLOCKS,
  ...CONTAINER_BLOCKS,
]);

export type BodyGaps = {
  // Block types the body leaves out, with their count.
  unrendered: Record<string, number>;
  // Notion-hosted files the body names but does not carry, by block type.
  files: Record<string, number>;
};

export function bodyGaps(blocks: NotionBlock[]): BodyGaps {
  const gaps: BodyGaps = { unrendered: {}, files: {} };
  const visit = (list: NotionBlock[]) => {
    for (const block of list) {
      if (!RENDERED_BLOCKS.has(block.type)) {
        gaps.unrendered[block.type] = (gaps.unrendered[block.type] ?? 0) + 1;
      } else if (FILE_BLOCKS.has(block.type) && notionHosted(block)) {
        gaps.files[block.type] = (gaps.files[block.type] ?? 0) + 1;
      }
      if (block.children?.length) visit(block.children);
    }
  };
  visit(blocks);
  return gaps;
}

function notionHosted(block: NotionBlock): boolean {
  const payload = blockPayload(block);
  return !payload.external?.url && Boolean(payload.file?.url);
}

function createService(): TurndownService {
  const instance = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  instance.use(gfm);
  return instance;
}

function renderBlocks(blocks: NotionBlock[]): string {
  let html = "";
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index] as NotionBlock;
    const listTag = listTagOf(block);
    if (listTag) {
      let items = "";
      while (
        index < blocks.length &&
        listTagOf(blocks[index] as NotionBlock) === listTag
      ) {
        items += renderListItem(blocks[index] as NotionBlock);
        index++;
      }
      html += `<${listTag}>${items}</${listTag}>`;
      continue;
    }
    html += renderBlock(block);
    index++;
  }
  return html;
}

function listTagOf(block: NotionBlock): "ul" | "ol" | null {
  if (block.type === "bulleted_list_item" || block.type === "to_do")
    return "ul";
  if (block.type === "numbered_list_item") return "ol";
  return null;
}

function renderListItem(block: NotionBlock): string {
  const payload = blockPayload(block);
  const checkbox =
    block.type === "to_do"
      ? `<input type="checkbox" disabled${payload.checked ? " checked" : ""}> `
      : "";
  const children = block.children?.length ? renderBlocks(block.children) : "";
  return `<li>${checkbox}${richTextToHtml(payload.rich_text)}${children}</li>`;
}

function renderBlock(block: NotionBlock): string {
  const payload = blockPayload(block);
  const text = richTextToHtml(payload.rich_text);
  const children = block.children?.length ? renderBlocks(block.children) : "";

  switch (block.type) {
    // A toggle heading keeps its content in children.
    case "heading_1":
      return `<h1>${text}</h1>${children}`;
    case "heading_2":
      return `<h2>${text}</h2>${children}`;
    case "heading_3":
      return `<h3>${text}</h3>${children}`;
    case "quote":
    case "callout":
      return `<blockquote><p>${text}</p>${children}</blockquote>`;
    case "code":
      return `<pre><code${languageClass(payload.language)}>${escapeHtml(plainCode(payload))}</code></pre>`;
    case "divider":
      return "<hr>";
    case "image":
    case "file":
    case "pdf":
    case "video":
    case "audio":
      return renderFile(block.type, payload) + caption(payload);
    case "table":
      return renderTable(block.children ?? []);
    case "equation":
      return `<pre><code class="language-math">${escapeHtml(payload.expression ?? "")}</code></pre>`;
    case "embed":
    case "bookmark":
    case "link_preview": {
      const url = payload.url ?? "";
      return (url ? link(url) : "") + caption(payload);
    }
    case "child_page":
      return `<p>${escapeHtml(payload.title ?? "")}</p>`;
    case "toggle":
      return `<p>${text}</p>${children}`;
    case "paragraph":
      return text ? `<p>${text}</p>${children}` : children;
    default:
      return text ? `<p>${text}</p>${children}` : children;
  }
}

function link(url: string): string {
  return `<p><a href="${escapeAttribute(url)}">${escapeHtml(url)}</a></p>`;
}

function caption(payload: { caption?: NotionRichText[] }): string {
  const text = richTextToHtml(payload.caption);
  return text ? `<p>${text}</p>` : "";
}

function renderFile(
  type: string,
  payload: { external?: { url?: string }; file?: { url?: string } },
): string {
  const external = payload.external?.url;
  if (external) {
    return type === "image"
      ? `<img src="${escapeAttribute(external)}" alt="">`
      : link(external);
  }
  return payload.file?.url ? `<p>${escapeHtml(FILE_STUB(type))}</p>` : "";
}

// GFM needs a header row; Notion tables often have none, so the first row
// serves as one either way.
function renderTable(rows: NotionBlock[]): string {
  const cells = rows
    .filter((row) => row.type === "table_row")
    .map((row) => blockPayload(row).cells ?? []);
  if (cells.length === 0) return "";
  const line = (tag: "th" | "td", row: NotionRichText[][]) =>
    `<tr>${row.map((cell) => `<${tag}>${richTextToHtml(cell)}</${tag}>`).join("")}</tr>`;
  const [head = [], ...body] = cells;
  return `<table><thead>${line("th", head)}</thead><tbody>${body.map((row) => line("td", row)).join("")}</tbody></table>`;
}

function plainCode(payload: { rich_text?: NotionRichText[] }): string {
  return (payload.rich_text ?? []).map((part) => part.plain_text).join("");
}

function languageClass(language: string | undefined): string {
  return language ? ` class="language-${escapeAttribute(language)}"` : "";
}

function richTextToHtml(rich: NotionRichText[] | undefined): string {
  return (rich ?? [])
    .map((part) => {
      let html = part.annotations?.code
        ? `<code>${escapeHtml(part.plain_text)}</code>`
        : escapeHtml(part.plain_text);
      if (part.annotations?.bold) html = `<strong>${html}</strong>`;
      if (part.annotations?.italic) html = `<em>${html}</em>`;
      if (part.annotations?.strikethrough) html = `<del>${html}</del>`;
      if (part.href)
        html = `<a href="${escapeAttribute(part.href)}">${html}</a>`;
      return html;
    })
    .join("");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;",
  );
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
