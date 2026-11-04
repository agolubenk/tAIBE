import {
  parseHealth,
  parseObservation,
  parseObservationDetail,
  parsePage,
  parseProjectsCatalog,
} from "./parse.js";
import type {
  FetchLike,
  Observation,
  ObservationDetail,
  Page,
  ProjectsCatalog,
  WorkerHealth,
} from "./types.js";

/** Worker answered with a non-2xx status. */
export class ClaudeMemHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ClaudeMemHttpError";
  }
}

/** Worker did not answer at all (network down, Mac asleep, timeout). */
export class ClaudeMemUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ClaudeMemUnavailableError";
  }
}

export type ListObservationsParams = {
  project?: string;
  platformSource?: string;
  contentSessionId?: string;
  limit?: number;
  offset?: number;
};

export type ClaudeMemReaderOptions = {
  /** Base URL of the worker, e.g. from resolveWorkerUrl(). */
  baseUrl: string;
  /** Injectable fetch; tests never hit the network. Defaults to global fetch. */
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Short default: the worker is local, so a slow answer means it is down. */
  timeoutMs?: number;
  /**
   * Called before every request (e.g. resolveProxyToken). A value goes only
   * into the PROXY_TOKEN_HEADER header, never into errors or results.
   */
  proxyToken?: () => string | undefined;
};

/** The header the Mac's read-only memory proxy checks (OPS-19). */
export const PROXY_TOKEN_HEADER = "x-cmem-proxy-token";

export type ClaudeMemReader = {
  health(): Promise<WorkerHealth>;
  listProjects(): Promise<ProjectsCatalog>;
  listObservations(params?: ListObservationsParams): Promise<Page<Observation>>;
  getObservation(id: number): Promise<ObservationDetail>;
};

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Read-only client for the claude-mem worker HTTP API. Every method is a GET;
 * the package performs no writes against claude-mem (N-001, R-040).
 */
export function createClaudeMemReader(
  options: ClaudeMemReaderOptions,
): ClaudeMemReader {
  const fetchImpl: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function get<T>(path: string, parse: (body: unknown) => T): Promise<T> {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = options.proxyToken?.();
    if (token) headers[PROXY_TOKEN_HEADER] = token;

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new ClaudeMemUnavailableError(
        `claude-mem worker unreachable at ${baseUrl}: ${reason}`,
        error,
      );
    }

    const body = await readBody(res);
    if (!res.ok) {
      throw new ClaudeMemHttpError(
        `claude-mem GET ${path}: HTTP ${res.status}`,
        res.status,
        body,
      );
    }
    return parse(body);
  }

  return {
    health: () => get("/api/health", parseHealth),
    listProjects: () => get("/api/projects", parseProjectsCatalog),
    listObservations: (params = {}) =>
      get(`/api/observations${queryString(params)}`, (body) =>
        parsePage(body, parseObservation),
      ),
    getObservation: (id) => {
      if (!Number.isInteger(id) || id <= 0) {
        return Promise.reject(
          new TypeError("observation id must be a positive integer"),
        );
      }
      return get(`/api/observation/${id}`, parseObservationDetail);
    },
  };
}

function queryString(params: ListObservationsParams): string {
  const search = new URLSearchParams();
  if (params.project) search.set("project", params.project);
  if (params.platformSource)
    search.set("platformSource", params.platformSource);
  if (params.contentSessionId) {
    search.set("contentSessionId", params.contentSessionId);
  }
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
