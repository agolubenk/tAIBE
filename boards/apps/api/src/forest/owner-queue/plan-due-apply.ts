import {
  type DueChoice,
  type DueRow,
  dueStateId,
  isDueChoice,
  readItemDue,
  readState,
} from "./plan-due";
import { cardRef, cardUid, type PlanRow, rowProduct } from "./plan-types";
import type { PlanWriter } from "./plan-writer";
import { type QueueDoc, QueueRejected } from "./queue-client";

// agentNote of a check: the queue refuses a longer one (checkSchema, 422).
const NOTE_MAX = 2000;
const clip = (note: string) =>
  note.length <= NOTE_MAX ? note : `${note.slice(0, NOTE_MAX - 1)}…`;

export type RowPatch = {
  id: string;
  version: number;
  patch: Record<string, unknown>;
};

// What one answer works on: the rows the owner read in the decision item and
// the plan rows of that product only.
type Answer = {
  item: QueueDoc;
  due: DueRow[];
  rows: PlanRow[];
  products: string[];
  product: string;
};

const uidOf = (entry: unknown) => {
  const ref = cardRef(entry);
  return ref ? cardUid(ref.ws, ref.key) : null;
};
const cardsOf = (row: PlanRow): unknown[] =>
  Array.isArray(row.data.cards) ? row.data.cards : [];

function ownRows(answer: Answer) {
  return new Map(
    answer.rows
      .filter((row) => rowProduct(row.id, answer.products) === answer.product)
      .map((row) => [row.id, row]),
  );
}

// The open backlog row of the row's direction, of the same product only: a
// card never goes into another product's plan.
function backlogRow(row: PlanRow, own: Map<string, PlanRow>) {
  const track = row.data.track;
  if (typeof track !== "string") return null;
  return (
    [...own.values()]
      .filter(
        (other) =>
          other.id !== row.id &&
          other.id.endsWith("-backlog") &&
          other.data.track === track &&
          other.data.status !== "done",
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null
  );
}

// «Держать срок»: the cut cards of the item go to the backlog row. The backlog
// rows are written first; a row loses its cards only after all of them.
export function keepWrites(answer: Answer) {
  const own = ownRows(answer);
  const backlogs = new Map<string, unknown[]>();
  const shrunk: RowPatch[] = [];
  const missing = new Set<string>();
  let moved = 0;
  for (const due of answer.due) {
    const row = own.get(due.id);
    if (!row) continue;
    const cut = new Set(due.cut.map((key) => key.toUpperCase()));
    const moving = cardsOf(row).filter((entry) => {
      const ref = cardRef(entry);
      return ref !== null && cut.has(ref.key.toUpperCase());
    });
    if (moving.length === 0) continue;
    const backlog = backlogRow(row, own);
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
    moved += moving.length;
    shrunk.push({
      id: row.id,
      version: row.version,
      patch: { cards: cardsOf(row).filter((entry) => !moving.includes(entry)) },
    });
  }
  const grown = [...backlogs].flatMap(([id, cards]) => {
    const row = own.get(id) as PlanRow;
    return JSON.stringify(cards) === JSON.stringify(cardsOf(row))
      ? []
      : [{ id, version: row.version, patch: { cards } }];
  });
  return { grown, shrunk, moved, missing: [...missing] };
}

// «Перенести»: planEnd = the item's moveTo date of the row, under the item's
// ref (the queue server checks both). A row already moved by this ref, or to
// that date, is done (a rerun after a partial apply).
export function moveWrites(answer: Answer) {
  const own = ownRows(answer);
  const writes: RowPatch[] = [];
  let done = 0;
  for (const due of answer.due) {
    const row = own.get(due.id);
    if (!row) continue;
    const planEnd =
      typeof row.data.planEnd === "string" ? row.data.planEnd.slice(0, 10) : "";
    const refs = Array.isArray(row.data.dueRefs) ? row.data.dueRefs : [];
    if (refs.includes(answer.item.id) || (planEnd && planEnd >= due.eta)) {
      done += 1;
      continue;
    }
    writes.push({
      id: row.id,
      version: row.version,
      patch: { planEnd: due.eta, dueRef: answer.item.id },
    });
  }
  return { writes, done };
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

const titleOf = (answer: Answer, id: string) => {
  const title = answer.rows.find((row) => row.id === id)?.data.title;
  return typeof title === "string" ? `«${title}»` : id;
};

// The moves; a 409 is either a race (the row changed: the next run tries
// again) or the queue refused the move itself (the row did not change).
async function applyMove(writer: PlanWriter, answer: Answer) {
  const { writes, done } = moveWrites(answer);
  const refused: string[] = [];
  let complete = true;
  for (const write of writes) {
    const result = await writer.patch(
      "work",
      write.id,
      write.patch,
      write.version,
    );
    if (result === "left") return { complete: false, note: "" };
    if (result !== "skipped") continue;
    const row = await writer.client.get("work", write.id);
    if (row?.version === write.version) refused.push(write.id);
    else complete = false;
  }
  const moved = done + writes.length - refused.length;
  const note = [
    `Перенесено строк: ${moved}.`,
    refused.length > 0
      ? `Очередь не приняла перенос: ${refused.map((id) => titleOf(answer, id)).join(", ")} — срок остался прежним.`
      : "",
  ];
  return { complete, note: note.filter(Boolean).join(" ") };
}

// The backlog rows first: any failure stops the answer before a row loses a
// card; the next run tries again.
async function applyKeep(writer: PlanWriter, answer: Answer) {
  const { grown, shrunk, moved, missing } = keepWrites(answer);
  for (const write of [...grown, ...shrunk]) {
    const result = await writer.patch(
      "work",
      write.id,
      write.patch,
      write.version,
    );
    if (typeof result === "string") return { complete: false, note: "" };
  }
  const note = [
    `В строки бэклога ушло карточек: ${moved}.`,
    missing.length > 0
      ? `Нет строки бэклога в направлении ${missing.join(", ")} — хвосты остались в строках.`
      : "",
  ];
  return { complete: true, note: note.filter(Boolean).join(" ") };
}

// The state doc closes: applied, with what the owner should know.
async function closeState(
  writer: PlanWriter,
  doc: QueueDoc,
  extra: Record<string, unknown>,
  now: Date,
) {
  const result = await writer.write(() =>
    writer.client.put(
      "work",
      doc.id,
      { ...doc.data, applied: true, appliedAt: now.toISOString(), ...extra },
      doc.version,
    ),
  );
  return typeof result !== "string";
}

async function applyOne(
  writer: PlanWriter,
  doc: QueueDoc,
  answer: Answer,
  choice: DueChoice,
  now: Date,
) {
  const done =
    choice === "move"
      ? await applyMove(writer, answer)
      : choice === "keep"
        ? await applyKeep(writer, answer)
        : { complete: true, note: "" };
  if (!done.complete) return false;
  // The owner reads the outcome on the decision itself, not in a service doc.
  if (done.note) {
    const noted = await writer.patch("checks", answer.item.id, {
      agentStatus: "done",
      agentNote: clip(done.note),
    });
    if (typeof noted === "string") return false;
  }
  // The item is archived only after the moves: the queue server lets a move
  // through while the item is unchanged since the answer (TB-112 part 1).
  if (!(await archiveItem(writer, answer.item.id))) return false;
  return closeState(
    writer,
    doc,
    { choice, ...(done.note ? { note: clip(done.note) } : {}) },
    now,
  );
}

// The queue refused a write of this answer (400/422: schema, size). A retry
// gets the same refusal every 5 minutes, so the answer closes unapplied: the
// owner reads why on the decision (blocked), the item stays open for them.
async function refuseAnswer(
  writer: PlanWriter,
  doc: QueueDoc,
  itemId: string,
  reason: string,
  now: Date,
) {
  console.warn(`owner-queue due: ${itemId} not applied: ${reason}`);
  const note = clip(
    `Ответ не применён: очередь отказала в записи (${reason}). Срок и строки не менялись.`,
  );
  try {
    if (await writer.client.get("checks", itemId)) {
      await writer.patch("checks", itemId, {
        agentStatus: "blocked",
        agentNote: note,
      });
    }
    await closeState(writer, doc, { note }, now);
  } catch (error) {
    if (!(error instanceof QueueRejected)) throw error;
    console.warn(
      `owner-queue due: ${itemId} state not closed: ${error.message}`,
    );
  }
}

// The answer counts for the text the owner read: the item is unchanged since
// the owner's answer (ownerAt is set by the queue server).
function answeredAfter(check: QueueDoc, item: QueueDoc) {
  const at =
    typeof check.data.ownerAt === "string"
      ? Date.parse(check.data.ownerAt)
      : Number.NaN;
  return Number.isFinite(at) && item.updatedAt <= at;
}

// Every run: an answered decision is applied, then archived and marked
// applied in its state doc. Everything the answer does comes from the item
// the owner read, never from the state doc: the state only points to it.
// A state that points to an archived item (applied already, or replaced by a
// newer decision), to a missing one or to an item that is not a t-boards
// decision of this product applies nothing and closes. Returns whether a
// work doc changed (the run reads the list again) and the products whose
// decision is still open: null — unanswered, a choice — answered, not
// applied yet.
type AnswerInput = {
  docs: QueueDoc[];
  rows: PlanRow[];
  products: string[];
  now: Date;
};

// One product's open decision. Returns what stays open: null — unanswered,
// a choice — answered, not applied yet; undefined — nothing open.
async function applyProduct(
  writer: PlanWriter,
  input: AnswerInput,
  product: string,
  doc: QueueDoc,
  itemId: string,
): Promise<DueChoice | null | undefined> {
  const item = await writer.client.get("items", itemId);
  const due = readItemDue(item, product);
  if (!item || !due || item.data.archived === true) {
    await closeState(
      writer,
      doc,
      { note: `решение ${itemId} в архиве или не найдено — не применяю` },
      input.now,
    );
    return undefined;
  }
  const check = await writer.client.get("checks", item.id);
  const choice = check?.data.choice;
  if (!check || !isDueChoice(choice)) return null;
  if (!answeredAfter(check, item)) {
    // The item changed after the answer: the owner did not see this text.
    // Nothing moves; rows: [] makes the next daily run ask again.
    if (await archiveItem(writer, item.id)) {
      await closeState(
        writer,
        doc,
        { rows: [], note: "решение изменено после ответа — спрошу заново" },
        input.now,
      );
    }
    return undefined;
  }
  const answer = {
    item,
    due,
    rows: input.rows,
    products: input.products,
    product,
  };
  return (await applyOne(writer, doc, answer, choice, input.now))
    ? undefined
    : choice;
}

export async function applyAnswers(writer: PlanWriter, input: AnswerInput) {
  const open = new Map<string, DueChoice | null>();
  const before = writer.written;
  for (const product of input.products) {
    const doc = input.docs.find((one) => one.id === dueStateId(product));
    const state = readState(doc?.data);
    if (!doc || !state || state.applied) continue;
    // A refused write stops this answer only: the rest of the run (other
    // products, F4, the daily part) goes on.
    try {
      const left = await applyProduct(writer, input, product, doc, state.item);
      if (left !== undefined) open.set(product, left);
    } catch (error) {
      if (!(error instanceof QueueRejected)) throw error;
      await refuseAnswer(writer, doc, state.item, error.message, input.now);
    }
  }
  return { changed: writer.written > before, open };
}
