import { type ClaudeMemReaderOptions, createJsonGetter } from "./client.js";
import {
  MAX_MEMORY_KEYS,
  type MemoryKeyForm,
  memoryKeyForm,
} from "./memory-keys.js";

/** One observation that names a key: a pointer and its title, never the text. */
export type CardMemoryLine = {
  id: number;
  title: string | null;
  project: string;
  createdAt: string;
};

export type CardMemoryKeyResult = {
  key: string;
  matchedOn: MemoryKeyForm;
  /** Matches, at most 500; capped means there were more. */
  count: number;
  capped: boolean;
  /** Up to 5, newest first. */
  latest: CardMemoryLine[];
};

export type CardMemoryAnswer = { keys: CardMemoryKeyResult[] };

export type CardMemoryClient = {
  find(keys: string[]): Promise<CardMemoryAnswer>;
};

/** The Mac proxy's own route: an exact key search in claude-mem.db (TB-113). */
export const CARD_MEMORY_PATH = "/api/card-memory";

const FORMS = new Set<MemoryKeyForm>(["id", "key", "queue"]);

export function createCardMemoryClient(
  options: ClaudeMemReaderOptions,
): CardMemoryClient {
  const get = createJsonGetter(options);
  return {
    find(keys) {
      if (
        keys.length === 0 ||
        keys.length > MAX_MEMORY_KEYS ||
        keys.some((key) => !memoryKeyForm(key))
      ) {
        return Promise.reject(
          new TypeError(
            `card memory takes 1 to ${MAX_MEMORY_KEYS} card ids, card keys or queue item ids`,
          ),
        );
      }
      const query = new URLSearchParams(keys.map((key) => ["key", key]));
      // The keys stay out of error messages: the label is the bare route.
      return get(
        `${CARD_MEMORY_PATH}?${query}`,
        parseCardMemory,
        CARD_MEMORY_PATH,
      );
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseLine(value: unknown): CardMemoryLine | null {
  const line = record(value);
  if (!line || typeof line.id !== "number" || !Number.isInteger(line.id)) {
    return null;
  }
  return {
    id: line.id,
    title: typeof line.title === "string" ? line.title : null,
    project: typeof line.project === "string" ? line.project : "",
    createdAt: typeof line.createdAt === "string" ? line.createdAt : "",
  };
}

function parseKey(value: unknown): CardMemoryKeyResult | null {
  const entry = record(value);
  if (
    !entry ||
    typeof entry.key !== "string" ||
    !FORMS.has(entry.matchedOn as MemoryKeyForm) ||
    typeof entry.count !== "number" ||
    !Array.isArray(entry.latest)
  ) {
    return null;
  }
  return {
    key: entry.key,
    matchedOn: entry.matchedOn as MemoryKeyForm,
    count: entry.count,
    capped: entry.capped === true,
    latest: entry.latest
      .map(parseLine)
      .filter((line): line is CardMemoryLine => line !== null),
  };
}

/** A body without a keys list is an error, not an empty answer. */
export function parseCardMemory(body: unknown): CardMemoryAnswer {
  const keys = record(body)?.keys;
  if (!Array.isArray(keys)) {
    throw new TypeError("card memory answer has no keys list");
  }
  return {
    keys: keys
      .map(parseKey)
      .filter((key): key is CardMemoryKeyResult => key !== null),
  };
}
