import type {
  CachedClaudeMemReader,
  CachedResult,
} from "@kaneo/claude-mem-reader";
import { redact } from "@kaneo/redact";

// TB-137 (N-009): claude-mem observations are agents' notes, and agents paste
// keys into them. The board does not own claude-mem.db (R-040), so it cleans
// what it gives out: every string at any depth (title, narrative, text,
// facts, file lists, detail metadata), not one chosen field, so a field the
// worker adds later is cleaned too. Only strings change: the shape stays.
export function redactStrings<T>(value: T): T {
  if (typeof value === "string") return redact(value).text as T;
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactStrings(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item)]),
    ) as T;
  }
  return value;
}

async function cleaned<T>(
  answer: Promise<CachedResult<T>>,
): Promise<CachedResult<T>> {
  const result = await answer;
  return { ...result, data: redactStrings(result.data) };
}

// The one point where observations leave the reader. The cache under it
// keeps the raw text in process memory only, never on disk (accepted by the
// TB-13 security lens); each read is cleaned again. Health and the project
// list carry no observation text.
export function withRedaction(
  reader: CachedClaudeMemReader,
): CachedClaudeMemReader {
  return {
    health: () => reader.health(),
    listProjects: () => reader.listProjects(),
    listObservations: (params) => cleaned(reader.listObservations(params)),
    getObservation: (id) => cleaned(reader.getObservation(id)),
  };
}
