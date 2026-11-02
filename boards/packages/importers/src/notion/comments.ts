import type { ImportedComment } from "../types.js";
import type { NotionComment, NotionPage } from "./api-types.js";
import { blocksToMarkdown } from "./body.js";
import type { NotionClient } from "./client.js";

const FALLBACK_AUTHOR = "Notion";

// The address of one comment in its discussion; a re-import finds the card's
// copy of the comment by it.
export function commentUrl(page: NotionPage, comment: NotionComment): string {
  const base = page.url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`;
  const discussion = comment.discussion_id.replace(/-/g, "");
  return `${base}?d=${discussion}#${comment.id.replace(/-/g, "")}`;
}

export function toImportedComments(
  page: NotionPage,
  comments: readonly NotionComment[],
  names: ReadonlyMap<string, string>,
): ImportedComment[] {
  return comments.map((comment) => {
    const authorId = comment.created_by?.id;
    return {
      // Name only, never the address (N-002).
      author: { name: (authorId && names.get(authorId)) || FALLBACK_AUTHOR },
      body: blocksToMarkdown([
        {
          id: comment.id,
          type: "paragraph",
          paragraph: { rich_text: comment.rich_text ?? [] },
        },
      ]),
      createdAt: comment.created_time,
      url: commentUrl(page, comment),
    };
  });
}

// One call per author the run has not met yet. An integration without the
// user-information capability gets a 403: the comment then keeps a neutral
// author rather than failing the run.
export async function resolveAuthorNames(
  client: NotionClient,
  comments: readonly NotionComment[],
  names: Map<string, string>,
): Promise<void> {
  for (const comment of comments) {
    const id = comment.created_by?.id;
    if (!id || names.has(id)) continue;
    const name = await client
      .getUser(id)
      .then((user) => user.name?.trim() || FALLBACK_AUTHOR)
      .catch(() => FALLBACK_AUTHOR);
    names.set(id, name);
  }
}
