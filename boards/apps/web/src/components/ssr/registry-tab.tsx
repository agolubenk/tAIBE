import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approveSsrDraft,
  getSsrDiff,
  listSsrDraftMatches,
  listSsrEntities,
  rejectSsrDraft,
  rollbackSsrEntity,
  type SsrEntity,
  type SsrVersionSummary,
} from "@/fetchers/ssr/ssr-fetchers";
import { Button } from "@/components/ui/button";
import { HttpError } from "@/lib/http-error";
import { ApproveMatchingBar } from "./approve-matching-bar";

// «Скиллы и правила» (spec RU-2, RU-11): the registry. Every entity with its
// versions; a diff opens before any owner decision — approve and rollback
// stay disabled until the diff is on screen. Approve and reject send the blob
// sha of the bytes that diff shows (TB-88): if the sync replaced the draft
// since, the server answers 409 SSR_DRAFT_CHANGED and the diff reloads.
const isDraftChanged = (error: unknown) =>
  error instanceof HttpError && error.code === "SSR_DRAFT_CHANGED";

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="bg-muted/50 max-h-96 overflow-auto rounded-md border border-border p-3 font-mono text-xs leading-relaxed">
      {diff}
    </pre>
  );
}

function VersionRow({
  workspaceId,
  entity,
  version,
  latestNumber,
}: {
  workspaceId: string;
  entity: SsrEntity;
  version: SsrVersionSummary;
  latestNumber: number | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [fromVersion, setFromVersion] = useState<number | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  const diff = useQuery({
    queryKey: [
      "ssr",
      "diff",
      workspaceId,
      entity.id,
      version.number,
      fromVersion,
    ],
    queryFn: () =>
      getSsrDiff(
        workspaceId,
        entity.id,
        fromVersion ? String(fromVersion) : "latest",
        String(version.number),
      ),
    enabled: diffOpen,
  });

  // The matching bar counts open drafts, so a single decision refreshes it too.
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["ssr", "entities", workspaceId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["ssr", "drafts", workspaceId],
      }),
    ]);

  // A stale diff is reloaded so the owner sees the bytes now waiting.
  const onDecisionError = (error: unknown) => {
    if (!isDraftChanged(error)) return;
    void queryClient.invalidateQueries({
      queryKey: ["ssr", "diff", workspaceId, entity.id, version.number],
    });
  };
  const approve = useMutation({
    mutationFn: (blobSha: string) =>
      approveSsrDraft(workspaceId, entity.id, version.id, blobSha),
    onSuccess: invalidate,
    onError: onDecisionError,
  });
  const reject = useMutation({
    mutationFn: (blobSha: string) =>
      rejectSsrDraft(workspaceId, entity.id, version.id, blobSha),
    onSuccess: invalidate,
    onError: onDecisionError,
  });
  // The bytes on screen: only a loaded, settled diff of this very version.
  const seenSha =
    diff.data && !diff.isFetching && diff.data.toVersionId === version.id
      ? diff.data.toBlobSha
      : null;
  const deciding = approve.isPending || reject.isPending;
  const rollback = useMutation({
    mutationFn: () => rollbackSsrEntity(workspaceId, entity.id, version.number),
    onSuccess: invalidate,
  });

  const isLatest = latestNumber === version.number;
  const fromOptions = entity.versions
    .filter((candidate) => candidate.number !== version.number)
    .map((candidate) => candidate.number);

  return (
    <li className="border-border border-t px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-sm">v{version.number}</span>
          <span className="text-muted-foreground text-xs">
            {version.status} · {version.origin}
          </span>
          <time
            className="text-muted-foreground text-xs"
            dateTime={version.createdAt}
          >
            {new Date(version.createdAt).toLocaleString()}
          </time>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-muted-foreground flex items-center gap-1 text-xs">
            {t("workspace:ssr.diffFrom")}
            <select
              className="bg-background border-input rounded-md border px-1 py-0.5 text-xs"
              value={fromVersion ?? ""}
              onChange={(event) =>
                setFromVersion(
                  event.target.value ? Number(event.target.value) : null,
                )
              }
            >
              <option value="">latest</option>
              {fromOptions.map((number) => (
                <option key={number} value={number}>
                  v{number}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDiffOpen((open) => !open)}
          >
            {diffOpen
              ? t("workspace:ssr.diffHide")
              : t("workspace:ssr.diffShow")}
          </Button>
          {version.status === "draft" ? (
            <>
              <Button
                type="button"
                size="sm"
                disabled={!diffOpen || !seenSha || deciding}
                onClick={() => seenSha && approve.mutate(seenSha)}
              >
                {t("workspace:ssr.approve")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!diffOpen || !seenSha || deciding}
                onClick={() => seenSha && reject.mutate(seenSha)}
              >
                {t("workspace:ssr.reject")}
              </Button>
            </>
          ) : null}
          {!isLatest &&
          version.status !== "draft" &&
          version.status !== "rejected" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!diffOpen || diff.isPending || rollback.isPending}
              onClick={() => rollback.mutate()}
            >
              {t("workspace:ssr.rollback")}
            </Button>
          ) : null}
        </div>
      </div>
      {diffOpen ? (
        <div className="mt-3 flex flex-col gap-2">
          {diff.isPending ? (
            <p className="text-muted-foreground text-xs">
              {t("common:loading")}
            </p>
          ) : null}
          {diff.isError ? (
            <p className="text-destructive text-xs">
              {t("workspace:ssr.loadError")}
            </p>
          ) : null}
          {diff.data
            ? diff.data.files.map((file) => (
                <div key={file.path}>
                  <p className="text-muted-foreground mb-1 font-mono text-xs">
                    {file.path} (v{diff.data?.from} → v{diff.data?.to})
                  </p>
                  <DiffBlock diff={file.diff} />
                </div>
              ))
            : null}
        </div>
      ) : null}
      {approve.isError || reject.isError || rollback.isError ? (
        <p className="text-destructive mt-2 text-xs" role="alert">
          {isDraftChanged(approve.error) || isDraftChanged(reject.error)
            ? t("workspace:ssr.draftChanged")
            : t("workspace:ssr.loadError")}
        </p>
      ) : null}
    </li>
  );
}

const entityAnchor = (entityId: string) => `ssr-entity-${entityId}`;

function locateEntity(entityId: string) {
  const section = document.getElementById(entityAnchor(entityId));
  section?.scrollIntoView({ block: "start" });
  section?.focus({ preventScroll: true });
}

export function RegistryTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const entities = useQuery({
    queryKey: ["ssr", "entities", workspaceId],
    queryFn: () => listSsrEntities(workspaceId),
  });
  // Asked only when the registry shows a draft, and as soon as it does.
  const hasDrafts =
    entities.data?.some((entity) =>
      entity.versions.some((version) => version.status === "draft"),
    ) ?? false;
  const drafts = useQuery({
    queryKey: ["ssr", "drafts", workspaceId],
    queryFn: () => listSsrDraftMatches(workspaceId),
    enabled: hasDrafts,
  });

  if (entities.isPending) {
    return (
      <p className="text-muted-foreground px-1 py-8 text-sm">
        {t("common:loading")}
      </p>
    );
  }
  if (entities.isError) {
    return (
      <p className="text-destructive px-1 py-8 text-sm">
        {t("workspace:ssr.loadError")}
      </p>
    );
  }
  const list = entities.data ?? [];
  if (list.length === 0) {
    return (
      <p className="text-muted-foreground px-1 py-8 text-sm">
        {t("workspace:ssr.empty")}
      </p>
    );
  }

  const latestNumbers = new Map(
    list.map((entity) => [
      entity.id,
      entity.versions.find((version) => version.status === "latest")?.number ??
        null,
    ]),
  );

  return (
    <div className="flex flex-col gap-3">
      {hasDrafts ? (
        <ApproveMatchingBar
          workspaceId={workspaceId}
          drafts={drafts.data}
          status={drafts.status}
          onLocate={locateEntity}
        />
      ) : null}
      {list.map((entity) => (
        <section
          key={entity.id}
          id={entityAnchor(entity.id)}
          tabIndex={-1}
          className="rounded-md border border-border bg-card overflow-hidden"
        >
          <header className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{entity.name}</span>
              <span className="text-muted-foreground font-mono text-xs">
                {entity.kind} · {entity.path}
              </span>
            </div>
            <span className="text-muted-foreground text-xs">
              {entity.status}
            </span>
          </header>
          <ol>
            {entity.versions.slice(0, 10).map((version) => (
              <VersionRow
                key={version.id}
                workspaceId={workspaceId}
                entity={entity}
                version={version}
                latestNumber={latestNumbers.get(entity.id) ?? null}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
