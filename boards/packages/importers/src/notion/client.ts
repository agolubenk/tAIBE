import { createJsonClient, type JsonClient } from "../http.js";
import type { FetchLike } from "../types.js";
import type {
  NotionBlock,
  NotionComment,
  NotionDatabase,
  NotionListResponse,
  NotionPage,
  NotionUser,
} from "./api-types.js";

export const NOTION_API_URL = "https://api.notion.com";
// 2025-09-03 moves database queries to `/v1/data_sources`; this version keeps
// `/v1/databases/{id}/query` and is the one infra/ai-council/notion.py reads
// the live workspace with. Pages still carry `in_trash` next to `archived`.
export const NOTION_VERSION = "2022-06-28";
// Notion caps `page_size` at 100.
export const NOTION_PAGE_SIZE = 100;

export type NotionClientOptions = {
  token: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
  // Shared by the clients withSignal derives, so a run counts every call.
  counter?: { calls: number };
};

export class NotionClient {
  private readonly options: NotionClientOptions;
  private readonly http: JsonClient;
  readonly counter: { calls: number };

  constructor(options: NotionClientOptions) {
    this.options = options;
    const counter = options.counter ?? { calls: 0 };
    this.counter = counter;
    const base: FetchLike =
      options.fetch ?? ((input, init) => fetch(input, init));
    this.http = createJsonClient({
      service: "Notion",
      baseUrl: NOTION_API_URL,
      headers: () => ({
        Authorization: `Bearer ${options.token}`,
        "Notion-Version": NOTION_VERSION,
      }),
      // Counted at the wire: a retried request is two calls against the limit.
      fetch: (input, init) => {
        counter.calls += 1;
        return base(input, init);
      },
      signal: options.signal,
      describeUnauthorized:
        "unauthorized (HTTP 401), check the Notion integration token and that it is shared with the databases",
    });
  }

  withSignal(signal: AbortSignal | undefined): NotionClient {
    if (!signal) return this;
    const current = this.options.signal;
    return new NotionClient({
      ...this.options,
      counter: this.counter,
      signal: current ? AbortSignal.any([current, signal]) : signal,
    });
  }

  get aborted(): boolean {
    return this.options.signal?.aborted ?? false;
  }

  me(): Promise<NotionUser> {
    return this.http.request<NotionUser>("/v1/users/me");
  }

  getUser(userId: string): Promise<NotionUser> {
    return this.http.request<NotionUser>(
      `/v1/users/${encodeURIComponent(userId)}`,
    );
  }

  // Open page-level comments only: Notion's API returns neither resolved
  // discussions nor, for a page id, the ones on its blocks.
  async listComments(pageId: string): Promise<NotionComment[]> {
    const comments: NotionComment[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({
        block_id: pageId,
        page_size: String(NOTION_PAGE_SIZE),
      });
      if (cursor) params.set("start_cursor", cursor);
      const response: NotionListResponse<NotionComment> =
        await this.http.request(`/v1/comments?${params}`);
      comments.push(...response.results);
      cursor = response.has_more ? response.next_cursor : null;
    } while (cursor);
    return comments;
  }

  getDatabase(databaseId: string): Promise<NotionDatabase> {
    return this.http.request<NotionDatabase>(
      `/v1/databases/${encodeURIComponent(databaseId)}`,
    );
  }

  // Every database the integration was given access to (Connections in
  // Notion), so a newly shared one is mirrored without a config change.
  async searchDatabases(): Promise<NotionDatabase[]> {
    const databases: NotionDatabase[] = [];
    let cursor: string | null = null;
    do {
      const response: NotionListResponse<NotionDatabase> =
        await this.http.request("/v1/search", {
          method: "POST",
          body: JSON.stringify({
            filter: { property: "object", value: "database" },
            page_size: NOTION_PAGE_SIZE,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        });
      databases.push(
        ...response.results.filter((d) => !d.archived && !d.in_trash),
      );
      cursor = response.has_more ? response.next_cursor : null;
    } while (cursor);
    return databases;
  }

  // One search page, for telling "nothing shared yet" from a wrong ID.
  async hasSharedDatabase(): Promise<boolean> {
    const response: NotionListResponse<NotionDatabase> =
      await this.http.request("/v1/search", {
        method: "POST",
        body: JSON.stringify({
          filter: { property: "object", value: "database" },
          page_size: 10,
        }),
      });
    return (
      response.has_more ||
      response.results.some((d) => !d.archived && !d.in_trash)
    );
  }

  async queryDatabase(
    databaseId: string,
    onPage?: (count: number) => void,
  ): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | null = null;
    do {
      const response: NotionListResponse<NotionPage> = await this.http.request(
        `/v1/databases/${encodeURIComponent(databaseId)}/query`,
        {
          method: "POST",
          body: JSON.stringify({
            page_size: NOTION_PAGE_SIZE,
            ...(cursor ? { start_cursor: cursor } : {}),
            // Stable order lets an interrupted import resume and diff.
            sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
          }),
        },
      );
      pages.push(...response.results);
      onPage?.(pages.length);
      cursor = response.has_more ? response.next_cursor : null;
    } while (cursor);
    return pages;
  }

  async listBlockChildren(
    blockId: string,
    onPage?: (count: number) => void,
  ): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({
        page_size: String(NOTION_PAGE_SIZE),
      });
      if (cursor) params.set("start_cursor", cursor);
      const response: NotionListResponse<NotionBlock> = await this.http.request(
        `/v1/blocks/${encodeURIComponent(blockId)}/children?${params}`,
      );
      blocks.push(...response.results);
      onPage?.(blocks.length);
      cursor = response.has_more ? response.next_cursor : null;
    } while (cursor);
    return blocks;
  }

  async readBlockTree(
    blockId: string,
    onChildren?: (blockId: string, blocks: NotionBlock[]) => void,
  ): Promise<NotionBlock[]> {
    const blocks = await this.listBlockChildren(blockId);
    onChildren?.(blockId, blocks);
    for (const block of blocks) {
      if (block.has_children) {
        block.children = await this.readBlockTree(block.id, onChildren);
      }
    }
    return blocks;
  }
}
