import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_CAP_MESSAGE,
  AGENT_IDLE_ARCHIVE_MS,
  AGENT_KEY_TTL_SECONDS,
  AGENTS_SETTINGS_PATH,
  MAX_AGENTS_PER_OWNER,
} from "./agent-limits";

describe("agent limits", () => {
  // TB-100 (owner, 07.11): 5 hours idle, cap 200 — eight new labels an hour
  // filled the cap of 50 within a day of a 24-hour wait.
  it("archives an agent idle for 5 hours, well before its key runs out", () => {
    expect(AGENT_IDLE_ARCHIVE_MS).toBe(5 * 60 * 60 * 1000);
    expect(AGENT_IDLE_ARCHIVE_MS).toBeLessThan(AGENT_KEY_TTL_SECONDS * 1000);
    expect(MAX_AGENTS_PER_OWNER).toBe(200);
  });

  // TB-72, TB-74: the agent cannot free a place; the text says what frees one
  // by itself and that only the owner disables, and where.
  it("tells a refused agent what frees a place and who disables", () => {
    expect(AGENT_CAP_MESSAGE).toContain(
      `${MAX_AGENTS_PER_OWNER} active agents`,
    );
    expect(AGENT_CAP_MESSAGE).toContain(
      "an agent idle for 5 hours goes to the archive by itself",
    );
    expect(AGENT_CAP_MESSAGE).toContain(
      "an archived agent comes back on its own when its session asks again",
    );
    expect(AGENT_CAP_MESSAGE).toContain(
      "while there is room, so ask again later",
    );
    expect(AGENT_CAP_MESSAGE).toContain("only the owner disables agents");
    expect(AGENT_CAP_MESSAGE).toContain(AGENTS_SETTINGS_PATH);
    expect(AGENT_CAP_MESSAGE).not.toContain("enabled agents");
  });
});
