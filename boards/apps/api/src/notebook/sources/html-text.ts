import { decodeEntities } from "./decode-entities";

// A fetched page is untrusted and up to LINK_MAX_BYTES. turndown measured
// quadratic on such input (20 000 <br> took 1.6 s, 2 MB would hold the event
// loop for minutes) and overflowed the stack at 5 000 nested <div>, so this is
// one forward pass with indexOf and no recursion. It keeps what search needs:
// headings as Markdown, paragraphs, list items and preformatted text.

const RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp"]);
// Dropped with their content: chrome, code and controls, not page text. The
// head needs nothing: its title, style and script are raw text, the rest void.
const SKIPPED = new Set([
  "noscript",
  "template",
  "svg",
  "math",
  "canvas",
  "iframe",
  "object",
  "select",
  "button",
  "nav",
  "footer",
]);
const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "center",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "form",
  "header",
  "hgroup",
  "hr",
  "html",
  "main",
  "menu",
  "ol",
  "p",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "ul",
]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "wbr"]);
const NAME_CHAR = /[a-z0-9-]/i;

type Tag = { name: string; closing: boolean; selfClosing: boolean };

class TextWriter {
  private parts: string[] = [];
  private breaks = 0;
  private prefix = "";
  heading = 0;
  pre = 0;

  block(newlines: number) {
    this.breaks = Math.max(this.breaks, newlines);
  }

  startLine(prefix: string, newlines: number) {
    this.block(newlines);
    this.prefix = prefix;
  }

  private flush() {
    if (this.parts.length && this.breaks) {
      const last = this.parts.length - 1;
      this.parts[last] = (this.parts[last] ?? "").trimEnd();
      this.parts.push("\n".repeat(this.breaks));
    }
    this.breaks = 0;
    this.parts.push(this.prefix);
    this.prefix = "";
  }

  text(raw: string) {
    if (this.pre) {
      this.raw(decodeEntities(raw));
      return;
    }
    let text = decodeEntities(raw.replace(/\s+/g, " "));
    if (this.breaks || this.prefix || !this.parts.length) {
      text = text.trimStart();
      if (!text) return;
      this.flush();
    }
    this.parts.push(text);
  }

  raw(text: string) {
    if (this.breaks || this.prefix) this.flush();
    this.parts.push(text);
  }

  toString() {
    return this.parts
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

function readTag(html: string, start: number): [Tag | null, number] {
  const closing = html[start + 1] === "/";
  const nameStart = start + (closing ? 2 : 1);
  let end = nameStart;
  while (end < html.length && NAME_CHAR.test(html[end] ?? "")) end++;
  if (end === nameStart) return [null, start + 1];
  const name = html.slice(nameStart, end).toLowerCase();
  // Quotes only open right after "=", so a stray one cannot swallow the page.
  let quote = "";
  let previous = "";
  for (; end < html.length; end++) {
    const char = html[end] ?? "";
    if (quote) {
      if (char === quote) quote = "";
    } else if ((char === '"' || char === "'") && previous === "=") {
      quote = char;
    } else if (char === ">") {
      break;
    }
    if (char.trim()) previous = char;
  }
  return [{ name, closing, selfClosing: html[end - 1] === "/" }, end + 1];
}

function applyTag(out: TextWriter, { name, closing }: Tag) {
  const level = /^h[1-6]$/.test(name) ? Number(name[1]) : 0;
  if (level) {
    if (closing) out.heading = 0;
    else out.heading = level;
    out.startLine(closing ? "" : `${"#".repeat(level)} `, 2);
    return;
  }
  switch (name) {
    case "br":
      if (out.pre) out.raw("\n");
      else if (out.heading) out.text(" ");
      else out.block(1);
      return;
    case "li":
      if (closing) out.block(1);
      else out.startLine("- ", 1);
      return;
    case "tr":
      out.block(1);
      return;
    case "td":
    case "th":
      if (!closing) out.text(" ");
      return;
    case "pre":
      if (closing) {
        out.pre = Math.max(0, out.pre - 1);
        if (!out.pre) {
          out.raw("\n```");
          out.block(2);
        }
      } else {
        if (!out.pre) {
          out.block(2);
          out.raw("```\n");
        }
        out.pre += 1;
      }
      return;
  }
  if (BLOCKS.has(name)) out.block(2);
}

export function htmlToText(html: string): { title: string; text: string } {
  const lower = html.toLowerCase();
  const out = new TextWriter();
  let title = "";
  let skip = 0;
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    const textEnd = open < 0 ? html.length : open;
    if (textEnd > at && !skip) out.text(html.slice(at, textEnd));
    if (open < 0) break;
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[open + 1] === "!" || html[open + 1] === "?") {
      const end = html.indexOf(">", open);
      at = end < 0 ? html.length : end + 1;
      continue;
    }
    const [tag, next] = readTag(html, open);
    at = next;
    if (!tag) {
      if (!skip) out.text("<");
      continue;
    }
    if (RAW_TEXT.has(tag.name) && !tag.closing && !tag.selfClosing) {
      const end = lower.indexOf(`</${tag.name}`, at);
      const content = html.slice(at, end < 0 ? html.length : end);
      if (tag.name === "title" && !title && !skip) {
        title = decodeEntities(content.slice(0, 2000).replace(/\s+/g, " "));
      }
      const close = end < 0 ? -1 : html.indexOf(">", end);
      at = close < 0 ? html.length : close + 1;
      continue;
    }
    if (SKIPPED.has(tag.name)) {
      if (tag.closing) skip = Math.max(0, skip - 1);
      else if (!tag.selfClosing && !VOID.has(tag.name)) skip += 1;
      continue;
    }
    if (!skip) applyTag(out, tag);
  }
  return { title: title.trim(), text: out.toString() };
}
