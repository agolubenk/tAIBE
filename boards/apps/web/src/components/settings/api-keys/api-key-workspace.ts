export const ALL_WORKSPACES = "all";

export function apiKeyWorkspaceMetadata(workspace: string) {
  return workspace === ALL_WORKSPACES ? undefined : { workspaceId: workspace };
}

// TB-96: a read-only key carries access "read"; the API answers 403 to any
// method but GET and HEAD.
export function apiKeyMetadata(workspace: string, readOnly: boolean) {
  const scope = apiKeyWorkspaceMetadata(workspace);
  return readOnly ? { ...scope, access: "read" as const } : scope;
}

// The API stores metadata as JSON text and may hand it back still encoded,
// so read both shapes. undefined means the metadata cannot be read.
function decodeMetadata(metadata: unknown): object | null | undefined {
  let value = metadata;
  for (let depth = 0; depth < 2 && typeof value === "string"; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

// Anything unreadable shows as "one workspace".
export function readApiKeyWorkspace(metadata: unknown): string | null {
  const value = decodeMetadata(metadata);
  if (value === null) return null;
  if (value === undefined) return "";
  if (!("workspaceId" in value)) return null;
  const { workspaceId } = value as { workspaceId: unknown };
  return typeof workspaceId === "string" ? workspaceId : "";
}

// Mirrors the API: an unknown access value or unreadable metadata reads only.
export function isReadOnlyApiKey(metadata: unknown): boolean {
  const value = decodeMetadata(metadata);
  if (value === null) return false;
  if (value === undefined) return true;
  if (!("access" in value)) return false;
  return (value as { access: unknown }).access !== "full";
}
