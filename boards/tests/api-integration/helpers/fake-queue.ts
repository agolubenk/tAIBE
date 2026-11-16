import {
  type QueueClient,
  type QueueCollection,
  QueueConflict,
  type QueueDoc,
  type QueueEvent,
} from "../../../apps/api/src/forest/owner-queue/queue-client";

// The owner queue in memory with its version rules (F17, F18): every write
// raises the version by one and adds a journal row under the writer's name;
// ifVersion 0 creates only; another ifVersion needs that exact version.
export class FakeQueue {
  readonly docs = new Map<string, QueueDoc>();
  readonly events = new Map<string, QueueEvent[]>();
  clock = () => Date.now();

  private key(collection: QueueCollection, id: string) {
    return `${collection}/${id}`;
  }

  write(
    actor: string,
    collection: QueueCollection,
    id: string,
    data: Record<string, unknown>,
    { ifVersion, merge }: { ifVersion?: number; merge: boolean },
  ): QueueDoc {
    const key = this.key(collection, id);
    const current = this.docs.get(key);
    if (ifVersion === 0 && current) throw new QueueConflict("exists");
    if (ifVersion !== undefined && ifVersion !== 0) {
      if (current?.version !== ifVersion) throw new QueueConflict("version");
    }
    const merged = merge ? { ...current?.data, ...data } : data;
    const doc: QueueDoc = {
      id,
      data: merged,
      version: (current?.version ?? 0) + 1,
      updatedAt: this.clock(),
      product:
        current?.product ?? (id.startsWith("taibe-") ? "taibe" : "hr-helper"),
    };
    this.docs.set(key, doc);
    const log = this.events.get(key) ?? [];
    log.unshift({
      at: doc.updatedAt,
      actor,
      action: merge ? "update" : "set",
      after: structuredClone(merged),
    });
    this.events.set(key, log);
    return structuredClone(doc);
  }

  // A client that writes under this token name.
  as(actor: string): QueueClient {
    return {
      get: async (collection, id) => {
        const doc = this.docs.get(this.key(collection, id));
        return doc ? structuredClone(doc) : null;
      },
      put: async (collection, id, data, ifVersion) =>
        this.write(actor, collection, id, data, { ifVersion, merge: false }),
      patch: async (collection, id, data, ifVersion) =>
        this.write(actor, collection, id, data, { ifVersion, merge: true }),
      history: async (collection, id) =>
        structuredClone(
          (this.events.get(this.key(collection, id)) ?? []).slice(0, 50),
        ),
      // The console answers a whole collection in one page.
      list: async (collection) => ({
        docs: [...this.docs.entries()]
          .filter(([key]) => key.startsWith(`${collection}/`))
          .map(([, doc]) => structuredClone(doc)),
        nextOffset: null,
        truncated: false,
      }),
    };
  }

  itemIds(): string[] {
    return [...this.docs.keys()]
      .filter((key) => key.startsWith("items/"))
      .map((key) => key.slice("items/".length));
  }

  doc(collection: QueueCollection, id: string) {
    return this.docs.get(this.key(collection, id));
  }
}
