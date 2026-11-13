import {
  type DueChoice,
  type DueState,
  dueStateId,
  isDueChoice,
  readState,
} from "./plan-due";
import { cardRef, cardUid, type PlanRow, rowProduct } from "./plan-types";
import type { PlanWriter } from "./plan-writer";
import type { QueueDoc } from "./queue-client";

export type RowPatch = {
  id: string;
  version: number;
  patch: Record<string, unknown>;
};

const uidOf = (entry: unknown) => {
  const ref = cardRef(entry);
  return ref ? cardUid(ref.ws, ref.key) : null;
};
const cardsOf = (row: PlanRow): unknown[] =>
  Array.isArray(row.data.cards) ? row.data.cards : [];

// The open backlog row of the row's direction; one of the same product first.
function backlogRow(row: PlanRow, rows: PlanRow[], products: string[]) {
  const track = row.data.track;
  if (typeof track !== "string") return null;
  const own = (id: string) =>
    Number(rowProduct(id, products) === rowProduct(row.id, products));
  return (
    rows
      .filter(
        (other) =>
          other.id !== row.id &&
          other.id.endsWith("-backlog") &&
          other.data.track === track &&
          other.data.status !== "done",
      )
      .sort((a, b) => own(b.id) - own(a.id) || a.id.localeCompare(b.id))[0] ??
    null
  );
}

// «Держать срок»: the cut cards go to the backlog row; the backlog rows are
// written before the rows lose them, so a failed write never drops a card.
function keepWrites(state: DueState, rows: PlanRow[], products: string[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const backlogs = new Map<string, unknown[]>();
  const shrunk: RowPatch[] = [];
  const missing = new Set<string>();
  for (const due of state.rows) {
    const row = byId.get(due.id);
    if (!row) continue;
    const cut = new Set(due.cut.map((key) => key.toUpperCase()));
    const moving = cardsOf(row).filter((entry) => {
      const ref = cardRef(entry);
      return ref !== null && cut.has(ref.key.toUpperCase());
    });
    if (moving.length === 0) continue;
    const backlog = backlogRow(row, rows, products);
    if (!backlog) {
      missing.add(String(row.data.track ?? "—"));
      continue;
    }
    const cards = backlogs.get(backlog.id) ?? [...cardsOf(backlog)];
    const have = new Set(cards.map(uidOf));
    for (const entry of moving) {
      if (!have.has(uidOf(entry))) cards.push(entry);
      have.add(uidOf(entry));
    }
    backlogs.set(backlog.id, cards);
    shrunk.push({
      id: row.id,
      version: row.version,
      patch: { cards: cardsOf(row).filter((entry) => !moving.includes(entry)) },
    });
  }
  const grown = [...backlogs].flatMap(([id, cards]) => {
    const row = byId.get(id) as PlanRow;
    return JSON.stringify(cards) === JSON.stringify(cardsOf(row))
      ? []
      : [{ id, version: row.version, patch: { cards } }];
  });
  const note =
    missing.size > 0
      ? `нет строки бэклога в направлении ${[...missing].join(", ")}`
      : undefined;
  return { writes: [...grown, ...shrunk], note };
}

// «Перенести»: planEnd = the forecast, under the decision's ref (the queue
// server checks it). A row already moved by this ref, or to that date, is done.
function moveWrites(state: DueState, rows: PlanRow[]): RowPatch[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return state.rows.flatMap((due) => {
    const row = byId.get(due.id);
    if (!row) return [];
    const planEnd =
      typeof row.data.planEnd === "string" ? row.data.planEnd.slice(0, 10) : "";
    const refs = Array.isArray(row.data.dueRefs) ? row.data.dueRefs : [];
    if (refs.includes(state.item) || (planEnd && planEnd >= due.eta)) {
      return [];
    }
    return [
      {
        id: row.id,
        version: row.version,
        patch: { planEnd: due.eta, dueRef: state.item },
      },
    ];
  });
}

// The row writes of the owner's answer, in order; «оставить красными» writes
// nothing. A rerun after a full apply writes nothing.
export function answerWrites(
  state: DueState,
  choice: DueChoice,
  rows: PlanRow[],
  products: string[],
): { writes: RowPatch[]; note?: string } {
  if (choice === "move") return { writes: moveWrites(state, rows) };
  if (choice === "keep") return keepWrites(state, rows, products);
  return { writes: [] };
}

// A missing or archived item needs no write.
export async function archiveItem(writer: PlanWriter, id: string) {
  const item = await writer.client.get("items", id);
  if (!item || item.data.archived === true) return true;
  const result = await writer.patch(
    "items",
    id,
    { archived: true },
    item.version,
  );
  return typeof result !== "string";
}

async function applyOne(
  writer: PlanWriter,
  doc: QueueDoc,
  state: DueState,
  choice: DueChoice,
  input: { rows: PlanRow[]; products: string[]; now: Date },
) {
  const { writes, note } = answerWrites(
    state,
    choice,
    input.rows,
    input.products,
  );
  let complete = true;
  for (const write of writes) {
    const result = await writer.patch(
      "work",
      write.id,
      write.patch,
      write.version,
    );
    if (typeof result === "string") complete = false;
    if (result === "left") break;
  }
  if (!complete || !(await archiveItem(writer, state.item))) return false;
  const result = await writer.write(() =>
    writer.client.put(
      "work",
      doc.id,
      {
        ...doc.data,
        applied: true,
        appliedAt: input.now.toISOString(),
        choice,
        ...(note ? { note } : {}),
      },
      doc.version,
    ),
  );
  return typeof result !== "string";
}

// Every run: an answered decision is applied, then archived and marked
// applied in its state doc. Returns whether a work doc changed (the run reads
// the list again) and the products whose decision is still open: null —
// unanswered, a choice — answered, not applied yet.
export async function applyAnswers(
  writer: PlanWriter,
  input: { docs: QueueDoc[]; rows: PlanRow[]; products: string[]; now: Date },
) {
  const open = new Map<string, DueChoice | null>();
  const before = writer.written;
  for (const product of input.products) {
    const doc = input.docs.find((one) => one.id === dueStateId(product));
    const state = readState(doc?.data);
    if (!doc || !state || state.applied) continue;
    const check = await writer.client.get("checks", state.item);
    const choice = check?.data.choice;
    if (!isDueChoice(choice)) {
      open.set(product, null);
      continue;
    }
    if (!(await applyOne(writer, doc, state, choice, input))) {
      open.set(product, choice);
    }
  }
  return { changed: writer.written > before, open };
}
