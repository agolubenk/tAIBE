import { redact } from "@kaneo/redact";
import { and, asc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { projectTable, taskTable } from "../database/schema";
import { isMarkerQuery, matchesVisibleText } from "../utils/visible-match";
import { boundedTaskRead } from "./bounded-read";
import { maskedMatchPage } from "./masked-match-page";

export const BOARD_DESCRIPTION_MAX_BYTES = 64 * 1024;
export const DESCRIPTION_CHUNK_CHARACTERS = 32 * 1024;
export const DESCRIPTION_MATCH_PAGE_SIZE = 100;
export const projectDescriptionDeferred = sql<boolean>`coalesce(octet_length(${projectTable.description}) > ${BOARD_DESCRIPTION_MAX_BYTES}, false)`;
export const boardProjectDescription = sql<
  string | null
>`case when ${projectDescriptionDeferred} then null else ${projectTable.description} end`;
export const descriptionDeferred = sql<boolean>`coalesce(octet_length(${taskTable.description}) > ${BOARD_DESCRIPTION_MAX_BYTES}, false)`;
export const boardDescription = sql<
  string | null
>`case when ${descriptionDeferred} then null else ${taskTable.description} end`;

type DescriptionPageOptions = {
  offset: number;
  version?: string;
  publicProjectId?: string;
};

function descriptionPageConditions(
  taskId: string,
  options: DescriptionPageOptions,
): SQL[] {
  const conditions = [eq(taskTable.id, taskId)];
  if (options.publicProjectId)
    conditions.push(
      eq(taskTable.projectId, options.publicProjectId),
      eq(projectTable.isPublic, true),
    );
  if (options.version)
    conditions.push(sql`${taskTable}.xmin::text = ${options.version}`);
  return conditions;
}

function descriptionUnavailable(options: DescriptionPageOptions) {
  return new HTTPException(options.version ? 409 : 404, {
    message:
      "Description changed or is unavailable; refresh before loading it again",
  });
}

export async function getDescriptionPage(
  taskId: string,
  options: DescriptionPageOptions,
) {
  return boundedTaskRead(async (tx) => {
    const conditions = descriptionPageConditions(taskId, options);
    const [row] = await tx
      .select({
        content: sql<string>`coalesce(substring(${taskTable.description} from ${options.offset + 1}::integer for ${DESCRIPTION_CHUNK_CHARACTERS + 1}::integer), '')`,
        version: sql<string>`${taskTable}.xmin::text`,
      })
      .from(taskTable)
      .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
      .where(and(...conditions))
      .limit(1);
    if (!row) throw descriptionUnavailable(options);
    // PostgreSQL offsets count Unicode characters, not JavaScript UTF-16 units.
    const characters = Array.from(row.content);
    return {
      content: characters.slice(0, DESCRIPTION_CHUNK_CHARACTERS).join(""),
      version: row.version,
      nextOffset:
        characters.length > DESCRIPTION_CHUNK_CHARACTERS
          ? options.offset + DESCRIPTION_CHUNK_CHARACTERS
          : null,
    };
  });
}

// TB-143: a caller with a token pages the masked description. Pages cut the
// text that redact has already seen, so no secret is split at a page edge.
// Offsets count characters of the masked text; the version guards the row.
export async function getMaskedDescriptionPage(
  taskId: string,
  options: DescriptionPageOptions,
) {
  return boundedTaskRead(async (tx) => {
    const [row] = await tx
      .select({
        content: sql<string>`coalesce(${taskTable.description}, '')`,
        version: sql<string>`${taskTable}.xmin::text`,
      })
      .from(taskTable)
      .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
      .where(and(...descriptionPageConditions(taskId, options)))
      .limit(1);
    if (!row) throw descriptionUnavailable(options);
    const characters = Array.from(redact(row.content).text);
    const end = options.offset + DESCRIPTION_CHUNK_CHARACTERS;
    return {
      content: characters.slice(options.offset, end).join(""),
      version: row.version,
      nextOffset: characters.length > end ? end : null,
    };
  });
}

export async function getDeferredDescriptionMatches(
  projectId: string,
  query: string,
  after?: string,
) {
  return boundedTaskRead(async (tx) => {
    const rows = await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(
        and(
          eq(taskTable.projectId, projectId),
          descriptionDeferred,
          sql`strpos(lower(${taskTable.description}), lower(${query})) > 0`,
          after ? gt(taskTable.id, after) : undefined,
        ),
      )
      .orderBy(asc(taskTable.id))
      .limit(DESCRIPTION_MATCH_PAGE_SIZE + 1);
    const matches = rows.slice(0, DESCRIPTION_MATCH_PAGE_SIZE);
    return {
      ids: matches.map((row) => row.id),
      nextCursor:
        rows.length > DESCRIPTION_MATCH_PAGE_SIZE
          ? (matches.at(-1)?.id ?? null)
          : null,
    };
  });
}

// TB-191: a caller with a token reads descriptions masked, so a match counts
// only outside secrets. The page is a window of deferred rows by id, cut by
// row count and stored size, never by matches: so the cursor does not show
// where a match inside a secret was. A page can hold no ids and still have a
// cursor. The query is searched only in the rows of the page (boards cost
// lens #350: the window has up to 101 rows, a page of 1 MiB at most 15), and
// only rows whose stored text holds it are loaded and masked.
export async function getVisibleDeferredDescriptionMatches(
  projectId: string,
  query: string,
  after?: string,
) {
  if (isMarkerQuery(query)) return { ids: [], nextCursor: null };
  return boundedTaskRead(async (tx) => {
    const window = await tx
      .select({
        id: taskTable.id,
        bytes: sql<number>`octet_length(${taskTable.description})`,
      })
      .from(taskTable)
      .where(
        and(
          eq(taskTable.projectId, projectId),
          descriptionDeferred,
          after ? gt(taskTable.id, after) : undefined,
        ),
      )
      .orderBy(asc(taskTable.id))
      .limit(DESCRIPTION_MATCH_PAGE_SIZE + 1);
    const page = maskedMatchPage(window, DESCRIPTION_MATCH_PAGE_SIZE);
    const texts = page.length
      ? await tx
          .select({ id: taskTable.id, description: taskTable.description })
          .from(taskTable)
          .where(
            and(
              inArray(
                taskTable.id,
                page.map((row) => row.id),
              ),
              sql`strpos(lower(${taskTable.description}), lower(${query})) > 0`,
            ),
          )
      : [];
    const visible = new Set(
      texts
        .filter((row) => matchesVisibleText(row.description, query))
        .map((row) => row.id),
    );
    return {
      ids: page.filter((row) => visible.has(row.id)).map((row) => row.id),
      nextCursor:
        page.length < window.length ? (page.at(-1)?.id ?? null) : null,
    };
  });
}

export async function getPublicProjectDescriptionPage(
  projectId: string,
  options: { offset: number; version?: string },
) {
  return boundedTaskRead(async (tx) => {
    const [row] = await tx
      .select({
        content: sql<string>`coalesce(substring(${projectTable.description} from ${options.offset + 1}::integer for ${DESCRIPTION_CHUNK_CHARACTERS + 1}::integer), '')`,
        version: sql<string>`${projectTable}.xmin::text`,
      })
      .from(projectTable)
      .where(
        and(
          eq(projectTable.id, projectId),
          eq(projectTable.isPublic, true),
          options.version
            ? sql`${projectTable}.xmin::text = ${options.version}`
            : undefined,
        ),
      )
      .limit(1);
    if (!row)
      throw new HTTPException(options.version ? 409 : 404, {
        message:
          "Description changed or is unavailable; refresh before loading it again",
      });
    const characters = Array.from(row.content);
    return {
      content: characters.slice(0, DESCRIPTION_CHUNK_CHARACTERS).join(""),
      version: row.version,
      nextOffset:
        characters.length > DESCRIPTION_CHUNK_CHARACTERS
          ? options.offset + DESCRIPTION_CHUNK_CHARACTERS
          : null,
    };
  });
}
