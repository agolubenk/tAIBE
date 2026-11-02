import type { ImportedComment, ImportedProject } from "../types.js";
import { readSharedDatabase } from "./access.js";
import type { NotionDatabase, NotionPage } from "./api-types.js";
import { type BodyGaps, blocksToMarkdown, bodyGaps } from "./body.js";
import type { NotionClient } from "./client.js";
import { resolveAuthorNames, toImportedComments } from "./comments.js";
import { mapDatabase } from "./mapping.js";

export type NotionMirrorRead = {
  database: NotionDatabase;
  pages: NotionPage[];
  project: ImportedProject;
  // What the bodies read in this run leave out, summed over the pages.
  gaps: BodyGaps;
};

export type ReadNotionMirrorOptions = {
  product: string;
  // Called once with every page, before any body is read; returns the ids
  // whose bodies to read. A page whose card is already current needs none:
  // the mirror rewrites a card only when Notion edited it since (R-080), so
  // skipping saves a request per page and keeps a scheduled run within
  // Notion's rate limit.
  selectBodies?: (
    pages: readonly NotionPage[],
  ) => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  onProgress?: (message: string) => void;
  footerFields?: RegExp;
  // Read the comments of every page whose body is read. A new comment does
  // not always move the page's last_edited_time, so only a full pass sees
  // them all.
  comments?: boolean;
};

// One read serves both the sync and the reconciliation (AC-002): the mapped
// project for the writer and the raw pages and database for `reconcile`.
export async function readNotionMirror(
  client: NotionClient,
  databaseId: string,
  options: ReadNotionMirrorOptions,
): Promise<NotionMirrorRead> {
  const { onProgress } = options;
  onProgress?.("Reading database");
  const database = await readSharedDatabase(client, databaseId);

  onProgress?.("Reading pages");
  const pages = await client.queryDatabase(databaseId, (count) =>
    onProgress?.(`Reading pages (${count} so far)`),
  );

  const selected = options.selectBodies
    ? await options.selectBodies(pages)
    : null;
  const wanted = selected
    ? pages.filter((page) => selected.has(page.id))
    : pages;
  const bodies = new Map<string, string>();
  const gaps: BodyGaps = { unrendered: {}, files: {} };
  const comments = new Map<string, ImportedComment[]>();
  const authors = new Map<string, string>();
  let read = 0;
  for (const page of wanted) {
    read += 1;
    onProgress?.(`Reading page bodies (${read}/${wanted.length})`);
    const blocks = await client.readBlockTree(page.id);
    bodies.set(page.id, blocksToMarkdown(blocks));
    const found = bodyGaps(blocks);
    addCounts(gaps.unrendered, found.unrendered);
    addCounts(gaps.files, found.files);
    if (options.comments) {
      const listed = await client.listComments(page.id);
      await resolveAuthorNames(client, listed, authors);
      comments.set(page.id, toImportedComments(page, listed, authors));
    }
  }

  return {
    database,
    pages,
    project: mapDatabase(database, pages, bodies, options.product, {
      footerFields: options.footerFields,
      ...(options.comments ? { comments } : {}),
    }),
    gaps,
  };
}

function addCounts(
  into: Record<string, number>,
  from: Readonly<Record<string, number>>,
) {
  for (const [type, count] of Object.entries(from)) {
    into[type] = (into[type] ?? 0) + count;
  }
}
