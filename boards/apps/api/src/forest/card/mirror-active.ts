import { readMirrorConfig } from "../../import/notion-mirror/mirror-config";

// While the scheduled mirror runs for the workspace, a card imported from
// Notion keeps its Notion fields read-only (R-081): the next run would
// overwrite a local edit anyway. With the mirror off — the canon moved to
// t-boards (R-084, d-tb-canon-3010) and Notion is a frozen archive — the
// fields belong to the card like on any card that never came from Notion:
// Notion fields are the owner's (and the creating agent's), half-baked still
// the owner's alone (Q-011).
export function isMirrorActive(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return readMirrorConfig(env)?.workspaceId === workspaceId;
}
