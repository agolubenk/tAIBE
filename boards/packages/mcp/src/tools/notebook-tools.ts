import { z } from "zod";
import { errorResult, textResult } from "../utils/mcp-result.js";
import type { ToolClient } from "./register.js";
import { type RegisterTool, run } from "./register-tool.js";

// Owner decision 13.11: ideation, solution research and spec work go through
// the notebook, so the owner sees them in «Вопросы». notebook_ask and
// notebook_brief spend a call of the notebook model (one daily cap shared by
// people and agents) and write the thread: they are writes behind a read
// permission, so they stay out of READ_TOOLS (no etag, no R-031 cut, no
// fullRef re-run that would ask again) and out of AGENT_WRITE_TOOLS (no lease:
// a thread is not a card).

type Citation = { n: number; kind: string; ref: string; title: string };
type Message = {
  role: "user" | "assistant";
  content: string;
  status: string | null;
  citations: Citation[];
  model: string | null;
};
type ThreadAnswer = { thread: { id: string }; messages: Message[] };

const ANSWER_CHARS_DEFAULT = 2400;
const CITATIONS_MAX = 5;

const lastAssistant = (answer: ThreadAnswer) =>
  [...answer.messages].reverse().find((m) => m.role === "assistant");

// Only a written answer or brief is a success. capped, rate-limited, failed
// and retrieval-only come back as 201 with empty text: an agent that reads
// only the text would take "" for "nothing found" and ask again.
function shapeAnswer(
  answer: ThreadAnswer,
  okStatus: "answered" | "brief",
  maxChars: number,
) {
  const message = lastAssistant(answer);
  const citations = (message?.citations ?? [])
    .slice(0, CITATIONS_MAX)
    .map(({ n, kind, ref, title }) => ({ n, kind, ref, title }));
  const text = message?.content ?? "";
  const shaped = {
    threadId: answer.thread.id,
    status: message?.status ?? "none",
    model: message?.model ?? null,
    answer:
      text.length > maxChars
        ? `${text.slice(0, maxChars)}… [cut at ${maxChars} chars; the full answer is in the thread]`
        : text,
    citations,
  };
  if (shaped.status === okStatus) return textResult(shaped);
  return textResult(
    {
      ...shaped,
      error: `notebook model gave no ${okStatus === "brief" ? "brief" : "answer"}: ${shaped.status}. Do not ask again now: use notebook_search and the citations.`,
    },
    true,
  );
}

async function settle(
  fn: () => Promise<unknown>,
  shape: (answer: ThreadAnswer) => ReturnType<typeof textResult>,
) {
  try {
    return shape((await fn()) as ThreadAnswer);
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }
}

export function registerNotebookTools(
  registerTool: RegisterTool,
  client: ToolClient,
) {
  registerTool(
    "notebook_search",
    {
      description:
        "Search the team notebook (repository docs, specs, rules and board cards) by words and, while the embedding worker is online, by meaning. Each hit is a chunk with its heading path and source (kind, ref, title): quote or cite it instead of reading the whole document. A card's ref is its task id.",
      inputSchema: z.object({
        workspaceId: z.string().trim().min(1),
        query: z.string().trim().min(1).max(500),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum hits, 1 to 20. Defaults to 8."),
        mode: z
          .enum(["hybrid", "keyword"])
          .optional()
          .describe(
            "keyword skips the meaning-based pass and answers at once. Defaults to hybrid.",
          ),
      }),
    },
    ({ workspaceId, ...body }) =>
      run(() =>
        client.json(`/api/notebook/${encodeURIComponent(workspaceId)}/search`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      ),
  );

  registerTool(
    "notebook_ask",

    {
      description:
        "Ask the team notebook a question that needs reasoning, not a quote. The notebook finds the sources and the notebook model (GLM) writes an answer citing them as [n]; the thread appears in the notebook «Вопросы» tab for the owner. Pass threadId to ask a follow-up in the same thread. Each call spends one call of a daily cap shared by people and agents: try notebook_search first, and do not repeat a question that came back capped or failed.",
      inputSchema: z.object({
        workspaceId: z.string().trim().min(1),
        question: z.string().trim().min(1).max(2000),
        threadId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Continue this thread instead of starting a new one."),
        maxAnswerChars: z
          .number()
          .int()
          .min(200)
          .max(8000)
          .optional()
          .describe(
            `Cut the answer text at this length. Defaults to ${ANSWER_CHARS_DEFAULT}.`,
          ),
      }),
    },

    ({ workspaceId, question, threadId, maxAnswerChars }) => {
      const ws = encodeURIComponent(workspaceId);
      const path = threadId
        ? `/api/notebook/${ws}/threads/${encodeURIComponent(threadId)}/messages`
        : `/api/notebook/${ws}/threads`;
      return settle(
        () =>
          client.json(path, {
            method: "POST",
            body: JSON.stringify({ question }),
          }),
        (answer) =>
          shapeAnswer(
            answer,
            "answered",
            maxAnswerChars ?? ANSWER_CHARS_DEFAULT,
          ),
      );
    },
  );

  registerTool(
    "notebook_brief",

    {
      description:
        "Turn a notebook thread into a GOAL/CONSTRAINTS/ACCEPTANCE brief written by the notebook model, for a spec or a card. Returns the thread's latest brief when it already has one; force writes a new one and spends a call of the shared daily cap.",
      inputSchema: z.object({
        workspaceId: z.string().trim().min(1),
        threadId: z.string().trim().min(1),
        force: z
          .boolean()
          .optional()
          .describe("Write a new brief even when the thread has one."),
      }),
    },

    ({ workspaceId, threadId, force }) => {
      const base = `/api/notebook/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}`;
      return settle(
        async () => {
          if (!force) {
            const current = (await client.json(base, {
              method: "GET",
            })) as ThreadAnswer;
            if (lastAssistant(current)?.status === "brief") return current;
          }
          return client.json(`${base}/brief`, { method: "POST" });
        },
        (answer) => shapeAnswer(answer, "brief", 8000),
      );
    },
  );
}
