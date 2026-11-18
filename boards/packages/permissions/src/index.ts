import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

export const statement = {
  ...defaultStatements,
  project: ["create", "read", "update", "delete", "share"],
  task: ["create", "read", "update", "delete", "assign"],
  label: ["create", "read", "update", "delete"],
  workspace: ["read", "update", "delete", "manage_settings"],
} as const;

export const ac = createAccessControl(statement);

export const viewer = ac.newRole({
  ...memberAc.statements,
  project: ["read"],
  task: ["read"],
  label: ["read"],
  workspace: ["read"],
});

export const member = ac.newRole({
  ...memberAc.statements,
  project: ["create", "read"],
  task: ["create", "read", "update"],
  label: ["create", "read", "update", "delete"],
  workspace: ["read"],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  project: ["create", "read", "update", "delete", "share"],
  task: ["create", "read", "update", "delete", "assign"],
  label: ["create", "read", "update", "delete"],
  workspace: ["read", "update", "manage_settings"],
});

export const owner = ac.newRole({
  ...ownerAc.statements,
  project: ["create", "read", "update", "delete", "share"],
  task: ["create", "read", "update", "delete", "assign"],
  label: ["create", "read", "update", "delete"],
  workspace: ["read", "update", "delete", "manage_settings"],
});

// R-010: a session's agent works cards, comments, leases and its work state,
// and reads the notebook. Projects, labels, settings and people stay with
// the owner; closing a card waits for the owner's approval in the forest.
// Never more than `member`, so an agent never outranks its owner.
export const agent = ac.newRole({
  ...memberAc.statements,
  project: ["read"],
  task: ["create", "read", "update"],
  label: ["read"],
  workspace: ["read"],
});

export const builtInRoles = { viewer, member, admin, owner, agent } as const;

export type BuiltInRoleName = keyof typeof builtInRoles;

// Default-role names that the API seeds per workspace. These ARE editable in
// the UI (their permissions live as rows in `workspace_role`), but their names
// are reserved and the rows are auto-created on workspace creation /
// backfilled at boot. `owner` is intentionally NOT in this list because it
// stays a true static role on the better-auth side.
export const DEFAULT_ROLE_NAMES = ["viewer", "member", "admin"] as const;
export type DefaultRoleName = (typeof DEFAULT_ROLE_NAMES)[number];

// Seeded next to the defaults in every workspace, but held only by agents:
// people are never offered it and agents get it from their owner's role.
export const AGENT_ROLE_NAME = "agent";
export const SEEDED_ROLE_NAMES = [
  ...DEFAULT_ROLE_NAMES,
  AGENT_ROLE_NAME,
] as const;
export type SeededRoleName = (typeof SEEDED_ROLE_NAMES)[number];

function toMutablePayload(
  statements: Record<string, readonly string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(statements)) {
    out[resource] = [...actions];
  }
  return out;
}

// Plain JSON-serializable permission payloads for the seeded default roles.
// Mirrors each role's `.statements` (including better-auth's organization/
// member/team/invitation/ac defaults) so a workspace_role row that uses one
// of these has parity with the prior static definition.
export const defaultRolePayloads: Record<
  SeededRoleName,
  Record<string, string[]>
> = {
  viewer: toMutablePayload(viewer.statements),
  member: toMutablePayload(member.statements),
  admin: toMutablePayload(admin.statements),
  agent: toMutablePayload(agent.statements),
};

export {
  WORKSPACE_CAPABILITY_NAMES,
  type WorkspaceCapability,
  workspaceCapabilities,
} from "./capabilities.js";

export {
  defaultPipelineSettings,
  isPipelineEnabled,
  normalizePipelineSettings,
  PIPELINE_TOGGLE_NAMES,
  type PipelineSettings,
  type PipelineToggle,
  pipelineToggles,
} from "./pipeline-toggles.js";

export {
  isReauthMethod,
  isSessionNotFresh,
  REAUTH_CODE_LENGTH,
  REAUTH_CODE_MAX_TRIES,
  REAUTH_CODE_TTL_SECONDS,
  REAUTH_ERRORS,
  REAUTH_FAILURE_LIMIT,
  REAUTH_FAILURE_WINDOW_SECONDS,
  REAUTH_FRESH_SECONDS,
  REAUTH_METHODS,
  REAUTH_ROUTES,
  type ReauthError,
  type ReauthErrorBody,
  type ReauthMethod,
} from "./reauth.js";

export {
  isAllowedUsername,
  isEmailLogin,
  RESERVED_USERNAMES,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  type UsernameProblem,
  usernameProblem,
} from "./username.js";
