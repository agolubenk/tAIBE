import { describe, expect, it } from "vite-plus/test";
import {
  assertTestDatabaseUrl,
  deriveTestDatabaseUrl,
} from "./helpers/database-url";

const url = (hostPort: string, db = "kaneo_test") =>
  `postgresql://kaneo:pw@${hostPort}/${db}`;

describe("integration DATABASE_URL guard (TB-145)", () => {
  it("refuses the ports of the live databases, the default port included", () => {
    for (const hostPort of ["localhost:5432", "127.0.0.1:5433", "localhost"]) {
      expect(() => assertTestDatabaseUrl(url(hostPort))).toThrow(
        /belongs to a live database.*scripts\/it-pg\.sh/,
      );
    }
  });

  it("accepts a database of its own on another port", () => {
    expect(() => assertTestDatabaseUrl(url("127.0.0.1:55400"))).not.toThrow();
  });

  it("still requires a database name ending in _test", () => {
    expect(() =>
      assertTestDatabaseUrl(url("127.0.0.1:55400", "kaneo")),
    ).toThrow(/ending in _test/);
    expect(deriveTestDatabaseUrl(url("127.0.0.1:55400", "kaneo"))).toBe(
      url("127.0.0.1:55400"),
    );
  });
});
