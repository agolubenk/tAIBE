import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest, relate } from "./helpers/forest";

// Fake secret assembled at runtime, so this file holds no key-shaped literal.
const join = (...parts: string[]) => parts.join("");
const SECRET = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const MARK = "[REDACTED:api_key]";

function seen(body: unknown) {
  const text = JSON.stringify(body);
  return { leaks: text.includes(SECRET), masked: text.includes(MARK) };
}

describe("API integration: sectors, felling reasons and the journal for callers with a token (TB-179)", () => {
  beforeEach(resetTestDatabase);

  it("masks a sector name, a refused felling's reason and the journal for an API key; the owner reads the titles", async () => {
    const forest = await createForest();
    const alpha = await addTask(forest.project.id, `alpha ${SECRET}`);
    const alphaChild = await addTask(forest.project.id, "alpha child");
    const beta = await addTask(forest.project.id, `beta ${SECRET}`);
    const betaChild = await addTask(forest.project.id, "beta child");
    if (!alpha || !alphaChild || !beta || !betaChild) {
      throw new Error("fixture");
    }
    await relate(alpha.id, alphaChild.id);
    await relate(beta.id, betaChild.id);
    await relate(alphaChild.id, betaChild.id, "related");

    // The sector is named after a root: «Sector: <title> +1».
    const detected = await forest.agent("/sectors/detect", {});
    expect(detected.status).toBe(200);
    expect(detected.body).toHaveLength(1);
    expect(seen(detected.body)).toEqual({ leaks: false, masked: true });
    const sectors = await forest.agent("/sectors");
    expect(sectors.status).toBe(200);
    expect(seen(sectors.body)).toEqual({ leaks: false, masked: true });
    expect(seen((await forest.owner("/sectors")).body).leaks).toBe(true);

    // The owner's «да» fells nothing: the cards are not done, and the
    // refusal names the root in the approval's reason and in the journal.
    const approval = await forest.agent("/approvals", {
      action: "fell_tree",
      targetId: alpha.id,
      reason: "done",
    });
    expect(approval.status).toBe(200);
    const decided = await forest.owner(
      `/approvals/${approval.body.id}/decide`,
      { decision: "approved" },
    );
    expect(decided.body.status).toBe("failed");
    expect(String(decided.body.failReason)).toContain(SECRET);

    for (const path of ["/approvals", "/journal"]) {
      const agent = await forest.agent(path);
      expect({ path, status: agent.status, ...seen(agent.body) }).toEqual({
        path,
        status: 200,
        leaks: false,
        masked: true,
      });
      const owner = await forest.owner(path);
      expect({ path, real: seen(owner.body).leaks }).toEqual({
        path,
        real: true,
      });
    }
  });
});
