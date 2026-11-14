import { and, desc, eq, sql } from "drizzle-orm";
import db from "../../database";
import { agentJournalTable, cardMetaTable } from "../../database/forest-schema";

const MAX_ACTORS = 50;

// TB-44 (R-036): what agents spent reading and writing a card through MCP —
// answer tokens (o200k_base, D-018) and calls per actor, from the journal.
// Money is the card's costUsd: the server never sees provider usage. Rows
// written before TB-44 are filed under the tool and are not counted.
export async function cardCost(taskId: string) {
  const journal = agentJournalTable;
  // Every mcp.call detail is JSON with numeric tokens (callDetail); the
  // checks keep one broken row from failing the whole sum. The CASEs are
  // nested because Postgres does not promise the order of an AND.
  const detail = sql`${journal.detail}::jsonb`;
  const tokens = sql<number>`coalesce(sum(case when pg_input_is_valid(${journal.detail}, 'jsonb') then case when jsonb_typeof(${detail} -> 'tokens') = 'number' then (${detail} ->> 'tokens')::numeric end end), 0)::int`;
  const calls = sql<number>`count(*)::int`;
  const first = sql<Date>`min(${journal.createdAt})`;
  const last = sql<Date>`max(${journal.createdAt})`;

  const callsAboutCard = and(
    eq(journal.targetType, "task"),
    eq(journal.targetId, taskId),
    eq(journal.action, "mcp.call"),
    eq(journal.outcome, "allowed"),
  );

  const [actors, [total], [meta]] = await Promise.all([
    db
      .select({
        actor: journal.actorName,
        calls,
        tokens,
        firstAt: first,
        lastAt: last,
      })
      .from(journal)
      .where(callsAboutCard)
      .groupBy(journal.actorName)
      .orderBy(desc(tokens))
      .limit(MAX_ACTORS + 1),
    db.select({ calls, tokens }).from(journal).where(callsAboutCard),
    db
      .select({ tokens: cardMetaTable.tokens, costUsd: cardMetaTable.costUsd })
      .from(cardMetaTable)
      .where(eq(cardMetaTable.taskId, taskId))
      .limit(1),
  ]);

  const shown = actors.slice(0, MAX_ACTORS);
  return {
    taskId,
    calls: total?.calls ?? 0,
    tokens: total?.tokens ?? 0,
    actors: shown.map((row) => ({
      ...row,
      firstAt: new Date(row.firstAt).toISOString(),
      lastAt: new Date(row.lastAt).toISOString(),
    })),
    truncated: actors.length > MAX_ACTORS,
    card: {
      tokens: meta?.tokens ?? null,
      costUsd: meta?.costUsd == null ? null : Number(meta.costUsd),
    },
  };
}
