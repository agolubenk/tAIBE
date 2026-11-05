import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_CAP_MESSAGE,
  AGENT_IDLE_ARCHIVE_MS,
  AGENT_KEY_TTL_SECONDS,
  AGENTS_SETTINGS_PATH,
  MAX_AGENTS_PER_OWNER,
} from "./agent-limits";

describe("agent limits", () => {
  it("archives an agent once its last key has run out", () => {
    expect(AGENT_IDLE_ARCHIVE_MS).toBe(AGENT_KEY_TTL_SECONDS * 1000);
    expect(AGENT_IDLE_ARCHIVE_MS).toBe(24 * 60 * 60 * 1000);
  });

  // TB-72, TB-74: the agent cannot free a place; the text says what frees one
  // by itself and that only the owner disables, and where.
  it("tells a refused agent what frees a place and who disables", () => {
    expect(AGENT_CAP_MESSAGE).toContain(
      `${MAX_AGENTS_PER_OWNER} active agents`,
    );
    expect(AGENT_CAP_MESSAGE).toContain(
      "an agent idle for 24 hours goes to the archive by itself",
    );
    expect(AGENT_CAP_MESSAGE).toContain(
      "an archived agent comes back on its own when its session asks again",
    );
    expect(AGENT_CAP_MESSAGE).toContain("only the owner disables agents");
    expect(AGENT_CAP_MESSAGE).toContain(AGENTS_SETTINGS_PATH);
    expect(AGENT_CAP_MESSAGE).not.toContain("enabled agents");
  });
});
