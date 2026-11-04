import { readMirrorConfig } from "../../import/notion-mirror/mirror-config";

// Notion is the source of a card's Notion fields (R-081) only while the
// scheduled mirror runs for the card's workspace. With the mirror off (Notion
// frozen, R-084) the board owns them, so the owner can change them; half-baked
// still moves only from the owner's session (Q-011). The mirror is configured
// per workspace, not per database of a card, and that is the precision here
// (TB-71).
export function isMirroredCard(
  workspaceId: string,
  notionPageId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!notionPageId) return false;
  return readMirrorConfig(env)?.workspaceId === workspaceId;
}
