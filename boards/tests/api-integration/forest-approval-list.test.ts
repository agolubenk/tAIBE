import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest, relate } from "./helpers/forest";

describe("API integration: approval list targets", () => {
  beforeEach(resetTestDatabase);

  it("names the card and the sector each request is about", async () => {
    const forest = await createForest();
    const alpha = await addTask(forest.project.id, "Alpha");
    const alphaChild = await addTask(forest.project.id, "Alpha / child");
    const beta = await addTask(forest.project.id, "Beta");
    const betaChild = await addTask(forest.project.id, "Beta / child");
    if (!alpha || !alphaChild || !beta || !betaChild) {
      throw new Error("fixture");
    }
    await relate(alpha.id, alphaChild.id);
    await relate(beta.id, betaChild.id);
    await relate(alphaChild.id, betaChild.id, "related");
    const detected = await forest.agent("/sectors/detect", {});
    const sector = detected.body[0];

    const closeCard = await forest.agent("/approvals", {
      action: "close_task",
      targetId: alphaChild.id,
      value: "done",
      reason: "finished",
      doneRef: "https://github.com/agolubenk/tAIBE/pull/1",
    });
    const fellSector = await forest.agent("/approvals", {
      action: "fell_sector",
      targetId: sector.id,
      reason: "release shipped",
    });
    expect(closeCard.status).toBe(200);
    expect(fellSector.status).toBe(200);

    const list = await forest.owner("/approvals?status=pending");
    expect(list.status).toBe(200);
    const byId = new Map(
      list.body.items.map((item: { id: string }) => [item.id, item]),
    );
    expect(byId.get(closeCard.body.id)).toMatchObject({
      target: {
        title: "Alpha / child",
        number: alphaChild.number,
        projectId: forest.project.id,
        projectName: forest.project.name,
      },
    });
    expect(byId.get(fellSector.body.id)).toMatchObject({
      target: { title: sector.name, projectId: null },
    });
  });
});
