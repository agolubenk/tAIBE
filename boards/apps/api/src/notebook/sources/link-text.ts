import { markdownHeading } from "../chunk/chunk-markdown";
import { htmlToText } from "./html-text";
import type { FetchedLink } from "./link-fetch";

export const LINK_TITLE_MAX = 300;

function firstHeading(markdown: string) {
  for (const line of markdown.split("\n", 200)) {
    const heading = markdownHeading(line);
    if (heading?.title) return heading.title;
  }
  return "";
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// The page becomes one source: its title as the top heading and its address,
// then the text, so a hit reads "Title › Section". HTML becomes Markdown-like
// text whose headings turn into chunks.
function plainPage(body: string) {
  const text = body.replace(/\r\n?/g, "\n").trim();
  return { title: firstHeading(text), text };
}

export function linkSourceText(url: URL, link: FetchedLink) {
  const page =
    link.mime === "text/html" ? htmlToText(link.body) : plainPage(link.body);
  const fallback = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  const title = (oneLine(page.title) || fallback).slice(0, LINK_TITLE_MAX);
  return {
    title,
    body: page.text,
    text: `# ${title}\n\n${url.href}\n\n${page.text}`,
  };
}
