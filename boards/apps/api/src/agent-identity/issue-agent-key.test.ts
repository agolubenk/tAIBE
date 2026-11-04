import { describe, expect, it } from "vite-plus/test";
import { agentCapMessage, MAX_AGENTS_PER_OWNER } from "./issue-agent-key";

// The refusal reaches agents that cannot act on it: only the owner lists and
// disables agents, so the text must say who does (TB-72).
describe("agentCapMessage", () => {
  it("names the owner as the one who disables agents", () => {
    const message = agentCapMessage();
    expect(message).toContain(`at most ${MAX_AGENTS_PER_OWNER} enabled agents`);
    expect(message).toContain("the owner disables");
    expect(message).toContain("an agent cannot");
    expect(message).not.toMatch(/^.*; disable the ones/);
  });

  it("keeps the configured cap in the text", () => {
    expect(agentCapMessage(7)).toContain("at most 7 enabled agents");
  });
});
