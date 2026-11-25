import { describe, expect, it } from "vite-plus/test";
import { migrateWithDriftCheck } from "../../../apps/api/src/database/migrate-with-drift-check";

// TB-251: the start step of TB-64. A drift check that is gone, runs before
// migrate() or reads NODE_ENV the wrong way round fails here.
type Database = Parameters<typeof migrateWithDriftCheck>[0];
const db = { execute: async () => ({ rows: [] }) } as unknown as Database;
const folder = "/drizzle";

const recordSteps = () => {
  const events: string[] = [];
  const production: boolean[] = [];
  const steps = {
    migrate: async (seen: Database, config: { migrationsFolder: string }) => {
      expect(seen).toBe(db);
      events.push(`migrate ${config.migrationsFolder}`);
    },
    checkDrift: async (
      seen: unknown,
      migrationsFolder: string,
      options: { production: boolean },
    ) => {
      expect(seen).toBe(db);
      events.push(`drift ${migrationsFolder}`);
      production.push(options.production);
      return [];
    },
  };
  return { events, production, steps };
};

describe("migrate-with-drift-check", () => {
  it("checks the drift right after migrate, on the same folder", async () => {
    const { events, steps } = recordSteps();

    await migrateWithDriftCheck(db, folder, { ...steps, env: {} });

    expect(events).toEqual(["migrate /drizzle", "drift /drizzle"]);
  });

  it("passes production only for NODE_ENV=production", async () => {
    const { production, steps } = recordSteps();

    for (const NODE_ENV of ["production", "development", "test", undefined]) {
      await migrateWithDriftCheck(db, folder, { ...steps, env: { NODE_ENV } });
    }

    expect(production).toEqual([true, false, false, false]);
  });

  it("does not check the drift when migrate fails", async () => {
    const { events, steps } = recordSteps();

    await expect(
      migrateWithDriftCheck(db, folder, {
        ...steps,
        env: {},
        migrate: async () => {
          throw new Error("migrate failed");
        },
      }),
    ).rejects.toThrow("migrate failed");

    expect(events).toEqual([]);
  });
});
