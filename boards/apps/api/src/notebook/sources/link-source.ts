import {
  FETCHED_SOURCE_CHUNKS_MAX,
  SOURCE_TEXT_MAX,
  SOURCE_URL_MAX,
} from "../routes/schema";
import { fetchLink, linkRefusal } from "./link-fetch";
import { withLinkSlot } from "./link-slots";
import { linkSourceText } from "./link-text";
import { upsertSource } from "./upsert-source";

// The ref is what the member pasted, without the fragment: the same page
// added again ("Refresh") replaces its text in place.
export function linkRef(input: string) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw linkRefusal(400, "LINK_INVALID_URL", "Enter a valid https URL.");
  }
  if (url.protocol !== "https:") {
    throw linkRefusal(400, "LINK_NOT_HTTPS", "Only https links can be added.");
  }
  if (url.username || url.password) {
    throw linkRefusal(
      400,
      "LINK_INVALID_URL",
      "A link with a user name or password cannot be added.",
    );
  }
  url.hash = "";
  // The ref is the encoded href, which can grow several times longer than
  // what was typed; a refresh sends it back through the same limit.
  if (url.href.length > SOURCE_URL_MAX) {
    throw linkRefusal(400, "LINK_INVALID_URL", "The link is too long.");
  }
  return url;
}

export async function addLinkSource(workspaceId: string, input: string) {
  const url = linkRef(input);
  const fetched = await withLinkSlot(workspaceId, () => fetchLink(url));
  const page = linkSourceText(url, fetched);
  if (!page.body) {
    throw linkRefusal(
      422,
      "LINK_EMPTY",
      "The page has no text to add; it may need JavaScript to show it.",
    );
  }
  if (page.text.length > SOURCE_TEXT_MAX) {
    throw linkRefusal(
      413,
      "LINK_TOO_LARGE",
      `The page text is longer than ${SOURCE_TEXT_MAX} characters.`,
    );
  }
  const stored = await upsertSource({
    workspaceId,
    kind: "link",
    ref: url.href,
    title: page.title,
    text: page.text,
    maxChunks: FETCHED_SOURCE_CHUNKS_MAX,
  });
  return { ...stored, kind: "link" as const, ref: url.href, title: page.title };
}
