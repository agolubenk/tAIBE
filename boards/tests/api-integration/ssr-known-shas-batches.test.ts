import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { syncCorpus } from "../../apps/api/src/ssr/sync";
import {
  KNOWN_SHAS_MAX,
  knownShasInBatches,
} from "../../deploy/vps/mac/ssr-sync.mjs";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";

// TB-95: the Mac sync (deploy/vps/mac/ssr-sync.mjs) used to ask about the
// whole corpus at once. It now asks in batches of KNOWN_SHAS_MAX (1000), the
// limit of a server before TB-129; the route limit itself (5000, TB-129) is
// tested in ssr-sync.test.ts.
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const commitSha = "6061626364656667686960616263646566676869";

describe("API integration: SSR known-shas in batches (Mac sync)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("asks about 1001 shas in two requests that the server accepts and merges the answers", async () => {
    const forest = await createForest();
    const stored = ["first", "last"];
    await syncCorpus(
      forest.workspace.id,
      {
        commitSha,
        files: stored.map((text) => ({
          path: `.claude/skills/${text}/NOTE.md`,
          sha256: sha256(text),
          content: text,
        })),
      },
      forest.ownerId,
    );
    // The stored shas sit in different batches: the first and the 1001st.
    const shas = Array.from({ length: 1001 }, (_, index) =>
      sha256(`probe-${index}`),
    );
    shas[0] = sha256("first");
    shas[1000] = sha256("last");
    const path = `/ssr/${forest.workspace.id}/known-shas`;

    const sizes: number[] = [];
    const known = await knownShasInBatches(async (batch: string[]) => {
      sizes.push(batch.length);
      const response = await forest.ownerApi("POST", path, { shas: batch });
      expect(response.status).toBe(200);
      return response.body;
    }, shas);
    expect(sizes).toEqual([KNOWN_SHAS_MAX, 1]);
    expect([...known].sort()).toEqual(stored.map(sha256).sort());
  });

  it("asks about a repeated sha once and sends nothing for an empty corpus", async () => {
    const asked: string[][] = [];
    const ask = async (batch: string[]) => {
      asked.push(batch);
      return { shas: [] };
    };

    expect((await knownShasInBatches(ask, [])).size).toBe(0);
    expect(asked).toEqual([]);

    const same = sha256("same");
    await knownShasInBatches(ask, [same, sha256("other"), same]);
    expect(asked).toEqual([[same, sha256("other")]]);
  });

  // A size below 1 would never move past the first batch.
  it("refuses a batch size that is not a whole number from 1", async () => {
    const ask = async () => ({ shas: [] });
    for (const size of [0, -1, 0.5, Number.NaN]) {
      await expect(
        knownShasInBatches(ask, [sha256("one")], size),
      ).rejects.toThrow(RangeError);
    }
  });
});
