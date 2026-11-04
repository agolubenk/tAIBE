import { describe, expect, it } from "vite-plus/test";
import { isMirroredCard } from "./card-mirror";
import { decideCardWrite } from "./decide-card-write";

const MIRROR = {
  NOTION_MIRROR_WORKSPACE_ID: "ws-1",
  NOTION_MIRROR_TOKEN_FILE: "/run/secrets/notion",
  NOTION_MIRROR_DATABASES: "db-a",
};

describe("isMirroredCard (TB-71)", () => {
  it("is mirrored only for a Notion card while the mirror runs for its workspace", () => {
    expect(isMirroredCard("ws-1", "page-1", MIRROR)).toBe(true);
    expect(isMirroredCard("ws-1", null, MIRROR)).toBe(false);
    expect(isMirroredCard("ws-2", "page-1", MIRROR)).toBe(false);
    expect(isMirroredCard("ws-1", "page-1", {})).toBe(false);
    expect(
      isMirroredCard("ws-1", "page-1", {
        ...MIRROR,
        NOTION_MIRROR_DATABASES: "",
      }),
    ).toBe(false);
  });

  it("mirror on: Notion fields stay read-only; off: the owner moves half-baked", () => {
    const owner = (env: NodeJS.ProcessEnv) => ({
      actorKind: "owner-ui" as const,
      mirrored: isMirroredCard("ws-1", "page-1", env),
      agentAuthored: false,
    });
    expect(decideCardWrite(["halfBaked"], owner(MIRROR))).toMatchObject({
      ok: false,
      code: "mirror_read_only",
    });
    expect(decideCardWrite(["halfBaked"], owner({}))).toEqual({ ok: true });
    // Off as well: half-baked is still the owner's alone (Q-011).
    expect(
      decideCardWrite(["halfBaked"], { ...owner({}), actorKind: "agent" }),
    ).toMatchObject({ ok: false, code: "owner_session_required" });
  });
});
