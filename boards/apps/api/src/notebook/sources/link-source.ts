import { SOURCE_TEXT_MAX } from "../routes/schema";
import { fetchLink, linkRefusal } from "./link-fetch";
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
  return url;
}

export async function addLinkSource(workspaceId: string, input: string) {
  const url = linkRef(input);
  const page = linkSourceText(url, await fetchLink(url));
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
  });
  return { ...stored, kind: "link" as const, ref: url.href, title: page.title };
}
