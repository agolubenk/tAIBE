// TB-102 R-8: one «да» for a final status walks the whole allowed path in one
// transaction. «Брёвна» (closed) take a card only from done, so a request to
// close from review or from work goes through done first. A card already in
// «Брёвна» is terminal: nothing else is reachable.
export type StatusPath =
  | { kind: "steps"; steps: string[] }
  | { kind: "already" }
  | { kind: "unreachable"; reason: string };

export function statusPath(current: string, target: string): StatusPath {
  if (current === target) return { kind: "already" };
  if (current === "closed") {
    return { kind: "unreachable", reason: "card_is_closed" };
  }
  if (target === "closed" && current !== "done") {
    return { kind: "steps", steps: ["done", "closed"] };
  }
  return { kind: "steps", steps: [target] };
}
