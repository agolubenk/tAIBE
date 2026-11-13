import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

export type SsrVersionSummary = {
  id: string;
  number: number;
  status: string;
  origin: string;
  message: string | null;
  commitSha: string | null;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
};

export type SsrEntity = {
  id: string;
  kind: string;
  name: string;
  path: string;
  status: string;
  latestVersionId: string | null;
  updatedAt: string;
  versions: SsrVersionSummary[];
};

export type SsrTimelineEvent = {
  versionId: string;
  number: number;
  status: string;
  origin: string;
  message: string | null;
  commitSha: string | null;
  createdAt: string;
  entityId: string;
  entityName: string;
  entityKind: string;
  entityPath: string;
};

export type SsrServed = {
  versionId: string;
  number: number;
  blobSha: string;
  files: Array<{ path: string; content: string; sha256: string }>;
};

export type SsrDiff = {
  from: number;
  to: number;
  toVersionId: string;
  toBlobSha: string;
  files: Array<{ path: string; diff: string }>;
};

export type SsrDraftMatch = {
  entityId: string;
  versionId: string;
  path: string;
  kind: string;
  blobSha: string;
  match: {
    workspaceId: string;
    workspaceName: string;
    versionId: string;
    number: number;
  } | null;
};

export type SsrBatchItem = { versionId: string; blobSha: string };

async function toResult(response: Response) {
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export async function listSsrEntities(workspaceId: string) {
  const response = await client.ssr[":workspaceId"].entities.$get({
    param: { workspaceId },
  });
  const body = await toResult(response);
  return body.entities as SsrEntity[];
}

export async function listSsrTimeline(workspaceId: string) {
  const response = await client.ssr[":workspaceId"].timeline.$get({
    param: { workspaceId },
    query: {},
  });
  const body = await toResult(response);
  return body.events as SsrTimelineEvent[];
}

export async function getSsrDiff(
  workspaceId: string,
  entityId: string,
  from: string,
  to: string,
) {
  const response = await client.ssr[":workspaceId"].entities[
    ":entityId"
  ].diff.$get({ param: { workspaceId, entityId }, query: { from, to } });
  return (await toResult(response)) as SsrDiff;
}

export async function approveSsrDraft(
  workspaceId: string,
  entityId: string,
  versionId: string,
  blobSha: string,
) {
  const response = await client.ssr[":workspaceId"].entities[
    ":entityId"
  ].approve.$post({
    param: { workspaceId, entityId },
    json: { versionId, blobSha },
  });
  return toResult(response);
}

export async function rejectSsrDraft(
  workspaceId: string,
  entityId: string,
  versionId: string,
  blobSha: string,
) {
  const response = await client.ssr[":workspaceId"].entities[
    ":entityId"
  ].reject.$post({
    param: { workspaceId, entityId },
    json: { versionId, blobSha },
  });
  return toResult(response);
}

export async function rollbackSsrEntity(
  workspaceId: string,
  entityId: string,
  toVersion: number,
) {
  const response = await client.ssr[":workspaceId"].entities[
    ":entityId"
  ].rollback.$post({
    param: { workspaceId, entityId },
    json: { toVersion },
  });
  return toResult(response);
}

export async function listSsrDraftMatches(workspaceId: string) {
  const response = await client.ssr[":workspaceId"].drafts.matches.$get({
    param: { workspaceId },
  });
  const body = await toResult(response);
  return body.drafts as SsrDraftMatch[];
}

export async function approveMatchingSsrDrafts(
  workspaceId: string,
  items: SsrBatchItem[],
) {
  const response = await client.ssr[":workspaceId"].drafts[
    "approve-matching"
  ].$post({ param: { workspaceId }, json: { items } });
  return (await toResult(response)) as {
    approved: number;
    versionIds: string[];
  };
}
