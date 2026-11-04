import { describe, expect, it, vi } from "vite-plus/test";
import { BUDGET_MAX } from "../view/fit-to-budget.js";
import { decodeWire, defaultCounter } from "../view/wire-format.js";
import { registerTools } from "./register.js";

// TB-3 / R-031: the worst notebook_search answer an agent gets by default —
// 8 hits (the tool's default limit), each a full chunk (CHUNK_MAX_CHARS = 1600
// in apps/api/src/notebook/chunk/chunk-markdown.ts) of Russian prose, which
// costs o200k more tokens than English.
const CHUNK_MAX_CHARS = 1600;
const SENTENCE =
  "Аренда карточки истекает через час, fencing token растёт с каждой выдачей, а агент продлевает её до конца шага. ";

type Hit = {
  chunkId: string;
  source: { kind: string; ref: string; title: string };
  heading: string;
  text: string;
  score: number;
  matchedBy: string[];
};

function worstCase(count: number) {
  const text = SENTENCE.repeat(
    Math.ceil(CHUNK_MAX_CHARS / SENTENCE.length),
  ).slice(0, CHUNK_MAX_CHARS);
  const results: Hit[] = Array.from({ length: count }, (_, i) => ({
    chunkId: `ck${String(i).padStart(22, "0")}`,
    source: {
      kind: "repo-doc",
      ref: `docs/impl/impl-b3-notebook-${i}.md`,
      title: `Блокнот: срез ${i}`,
    },
    heading: `Блокнот › Срез ${i} › Карточки и MCP`,
    text,
    score: 0.0312,
    matchedBy: ["vector", "keyword"],
  }));
  return { mode: "hybrid", results };
}

async function callSearch(answer: unknown, args: Record<string, unknown>) {
  type Handler = (
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, handler: Handler) => {
      tools.set(name, handler);
    }),
  };
  const client = { json: vi.fn().mockResolvedValue(answer) };
  registerTools(server as never, { client: client as never });
  const handler = tools.get("notebook_search");
  if (!handler) throw new Error("notebook_search is not registered");
  const text = (await handler(args)).content[0]?.text ?? "";
  return { text, tokens: defaultCounter.count(text) };
}

describe("notebook_search stays within the R-031 budget", () => {
  for (const limit of [8, 20]) {
    it(`fits ${limit} full chunks into ${BUDGET_MAX} tokens and keeps each kept hit's citation`, async () => {
      const answer = worstCase(limit);
      const raw = defaultCounter.count(JSON.stringify(answer));
      const { text, tokens } = await callSearch(answer, {
        workspaceId: "ws",
        query: "аренда",
        limit,
      });
      const fitted = decodeWire(text) as {
        truncated: boolean;
        fullRef: string;
        data: { results: Hit[] };
      };
      const kept = fitted.data.results;
      // Measured 04.11 (docs/impl/impl-r031-context.md): the cut drops whole
      // hits, not their text; `--silent=false` prints the numbers again.
      console.info(
        `notebook_search ${limit}×${CHUNK_MAX_CHARS}: raw ${raw} tokens → ${tokens}, hits ${limit} → ${kept.length}, text ${kept.map((hit) => hit.text.length).join("/")} chars`,
      );

      expect(raw).toBeGreaterThan(BUDGET_MAX);
      expect(tokens).toBeLessThanOrEqual(BUDGET_MAX);
      // A cut answer says so and how to ask for the rest.
      expect(fitted.truncated).toBe(true);
      expect(fitted.fullRef.startsWith("notebook_search ")).toBe(true);
      expect(kept.length).toBeGreaterThan(0);
      kept.forEach((hit, i) => {
        expect(hit).toMatchObject({
          chunkId: answer.results[i]?.chunkId,
          source: answer.results[i]?.source,
          heading: answer.results[i]?.heading,
        });
      });
    });
  }
});
