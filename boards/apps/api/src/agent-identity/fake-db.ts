import * as base from "../database/schema";
import * as forest from "../database/forest-schema";

// Unit tests only: a stand-in for the drizzle client. Every query records the
// table it reads or writes and each builder step; awaiting it asks `respond`
// for the rows. Transactions run their callback on the same client. What the
// SQL itself selects is proven by the API integration tests on PostgreSQL.
export const fakeSchema = { ...base, ...forest };

export type FakeQuery = {
  op: "select" | "insert" | "update" | "delete";
  table: unknown;
  fields: Record<string, unknown> | undefined;
  steps: { name: string; args: unknown[] }[];
};

export type FakeDbState = {
  respond: (query: FakeQuery) => unknown;
  queries: FakeQuery[];
};

export function createFakeDb(state: FakeDbState) {
  const start =
    (op: FakeQuery["op"]) =>
    (...args: unknown[]) => {
      const query: FakeQuery = {
        op,
        table: op === "select" ? undefined : args[0],
        fields:
          op === "select" ? (args[0] as Record<string, unknown>) : undefined,
        steps: [],
      };
      state.queries.push(query);
      const chain: object = new Proxy(
        {},
        {
          get(_, name) {
            if (name === "then") {
              return (
                ok: (value: unknown) => unknown,
                fail: (error: unknown) => unknown,
              ) =>
                Promise.resolve()
                  .then(() => state.respond(query))
                  .then(ok, fail);
            }
            return (...stepArgs: unknown[]) => {
              if (name === "from") query.table = stepArgs[0];
              query.steps.push({ name: String(name), args: stepArgs });
              return chain;
            };
          },
        },
      );
      return chain;
    };
  const db = {
    select: start("select"),
    insert: start("insert"),
    update: start("update"),
    delete: start("delete"),
    transaction: (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return db;
}

export function step(query: FakeQuery, name: string) {
  return query.steps.find((s) => s.name === name)?.args;
}
