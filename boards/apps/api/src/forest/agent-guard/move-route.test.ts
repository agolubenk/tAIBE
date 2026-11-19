import { describe, expect, it } from "vite-plus/test";
import { type MoveFacts, moveRoute } from "./move-facts";

const url = "/api/forest/w1/approvals";
const facts = (over: Partial<MoveFacts>): MoveFacts => ({
  landing: "finished",
  closes: true,
  reopens: false,
  wasClosed: false,
  fromFinal: false,
  landingFinal: true,
  ...over,
});

// Each route names only steps the guard lets through, and the «да» in the
// project the card is in at that step (TB-80, TB-82).
describe("moveRoute — the way round a move that needs a «да»", () => {
  it("reopens in the card's own project, then moves", () => {
    const route = moveRoute(
      facts({ landing: "new", closes: false, reopens: true, wasClosed: true }),
      url,
    );
    expect(route).toBe(
      `this move reopens the card: ask reopen_task in its own project with an open status of that project (POST ${url}), then move it`,
    );
  });

  it("moves an open card into an open column, then closes it in the destination", () => {
    expect(moveRoute(facts({}), url)).toContain(
      "move it into an open column of the destination first (destinationStatus), then ask close_task in the destination",
    );
  });

  it("closes a closed card in a final column of its project first", () => {
    // «Подтверждение», archived, a status no column backs.
    expect(moveRoute(facts({ wasClosed: true }), url)).toContain(
      `ask close_task in its own project with a final status of that project (POST ${url}), then move it into a final column of the destination`,
    );
  });

  it("lands in a final column, then asks the destination's closing stage", () => {
    const route = moveRoute(
      facts({
        landing: "confirmation",
        wasClosed: true,
        fromFinal: true,
        landingFinal: false,
      }),
      url,
    );
    expect(route).toContain(
      `: move it into a final column of the destination, then ask close_task in the destination for «confirmation» (POST ${url})`,
    );
    expect(route).not.toContain("in its own project");
  });

  it("walks both «да» for a closing stage into a closing stage", () => {
    const route = moveRoute(
      facts({ landing: "confirmation", wasClosed: true, landingFinal: false }),
      url,
    );
    expect(route.match(/ask close_task/g)).toHaveLength(2);
  });
});
