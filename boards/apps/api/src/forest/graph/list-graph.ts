import { decodeCursor, encodeCursor, pageSize } from "../read/page-cursor";
import { sectorName } from "../sector/sector-name";
import { fitNodeBudget } from "./fit-node-budget";
import { graphCards } from "./graph-cards";
import { cardLinks } from "./graph-links";
import { cardDecisions, cardFiles } from "./graph-refs-query";
import { cardSectors } from "./graph-sectors";

export type GraphEdgeType =
  | "subtask"
  | "blocks"
  | "related"
  | "file"
  | "decision";

// The links graph (R-090): cards, the files they touched and the decisions
// they cite, joined by explicit links and grouped by sector (R-029). A page
// holds at most `take` nodes; files and decisions a page shares with an
// earlier one come again, so the client keeps nodes by id. Cards of projects
// the reader may not open are neither nodes nor ends of links.
export async function listGraph({
  workspaceId,
  userId,
  cursor,
  take,
}: {
  workspaceId: string;
  userId: string;
  cursor?: string;
  take?: number;
}) {
  const budget = pageSize(take, 100);
  const after = decodeCursor(cursor);
  const rows = await graphCards({
    workspaceId,
    userId,
    after,
    limit: budget + 1,
  });
  const fetchedIds = rows.map((row) => row.id);
  const [files, decisions] = await Promise.all([
    cardFiles(fetchedIds),
    cardDecisions(fetchedIds),
  ]);
  const cards = fitNodeBudget(
    rows.map((row) => ({
      ...row,
      files: files.get(row.id) ?? [],
      decisions: decisions.get(row.id) ?? [],
    })),
    budget,
  );
  const cardIds = cards.map((card) => card.id);
  const [links, sectors] = await Promise.all([
    cardLinks({ workspaceId, userId, cardIds, after }),
    cardSectors(workspaceId, cardIds),
  ]);

  const edges = new Map<
    string,
    { source: string; target: string; type: GraphEdgeType }
  >();
  const addEdge = (source: string, target: string, type: GraphEdgeType) => {
    if (source !== target) {
      edges.set(`${type}|${source}|${target}`, { source, target, type });
    }
  };
  for (const link of links) {
    addEdge(link.source, link.target, link.type as GraphEdgeType);
  }
  for (const card of cards) {
    for (const path of card.files) addEdge(card.id, `file:${path}`, "file");
    for (const ref of card.decisions) {
      addEdge(card.id, `decision:${ref}`, "decision");
    }
  }

  const last = cards.at(-1);
  return {
    cards: cards.map(
      ({ createdAt: _, files: __, decisions: ___, ...card }) => ({
        ...card,
        sectorIds: sectors
          .filter((row) => row.card_id === card.id)
          .map((row) => row.sector_id),
      }),
    ),
    files: [...new Set(cards.flatMap((card) => card.files))].map((path) => ({
      id: `file:${path}`,
      path,
    })),
    decisions: [...new Set(cards.flatMap((card) => card.decisions))].map(
      (ref) => ({ id: `decision:${ref}`, ref }),
    ),
    edges: [...edges.values()],
    sectors: [
      ...new Map(
        sectors.map((row) => [
          row.sector_id,
          { id: row.sector_id, name: sectorName(row.name) },
        ]),
      ).values(),
    ],
    nextCursor:
      cards.length < rows.length && last
        ? encodeCursor({ at: last.createdAt, id: last.id })
        : null,
  };
}
