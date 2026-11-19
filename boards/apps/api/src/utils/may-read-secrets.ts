import type { Context } from "hono";
import { requestKeyAccess } from "./api-key-access";
import { hasWorkspacePermission } from "./require-workspace-permission";

// TB-96 R-017. A GET must not give a read-only key a secret that writes past
// the key: with a GitLab or Gitea webhook secret anyone can post events to the
// public webhook route, and those create, close and change tasks. New response
// fields that carry such a secret go through this check too.
export async function mayReadSecrets(c: Context): Promise<boolean> {
  if (requestKeyAccess(c) === "read") return false;
  return hasWorkspacePermission(c, { workspace: ["manage_settings"] });
}
