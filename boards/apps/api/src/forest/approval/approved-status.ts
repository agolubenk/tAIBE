import { asc, eq } from "drizzle-orm";
import { columnTable } from "../../database/schema";
import { VIRTUAL_STATUSES } from "../../task/validate-task-fields";
import { closesAt } from "../agent-guard/closing-status";
import type { Tx } from "../tx";
import { ApprovalFailure } from "./approval-failure";

export type ProjectStatus = { slug: string; closes: boolean };

// TB-90. The owner approves a status by its slug. When the «да» is applied,
// the slug can be gone (the column was renamed, the card was moved), or the
// column can close a card now where it did not (or the other way round). Then
// nothing changes, and the reason names the approved slug and the statuses
// to ask the owner for again.
export function approvedStatusFailure(
  statuses: readonly ProjectStatus[],
  target: string,
  closing: boolean,
): string | null {
  const found = statuses.find((status) => status.slug === target);
  if (found && found.closes === closing) return null;
  const askFor = statuses
    .filter((status) => status.closes === closing)
    .map((status) => status.slug)
    .join(", ");
  const ask = askFor
    ? `ask the owner again for one of: ${askFor}`
    : `the project has no ${closing ? "closing" : "open"} status`;
  const why = !found
    ? `status_gone: «${target}» is not a status of the card's project now`
    : closing
      ? `status_not_closing: «${target}» does not close the card now`
      : `status_closes: «${target}» closes the card now`;
  return `${why}; ${ask}`.slice(0, 500);
}

export async function projectStatuses(
  tx: Tx,
  projectId: string,
): Promise<ProjectStatus[]> {
  const columns = await tx
    .select({ slug: columnTable.slug, isFinal: columnTable.isFinal })
    .from(columnTable)
    .where(eq(columnTable.projectId, projectId))
    .orderBy(asc(columnTable.position));
  return [
    ...columns.map(({ slug, isFinal }) => ({
      slug,
      closes: closesAt(slug, isFinal),
    })),
    ...VIRTUAL_STATUSES.map((slug) => ({
      slug,
      closes: closesAt(slug, false),
    })),
  ];
}

export async function assertApprovedStatus(
  tx: Tx,
  projectId: string,
  target: string,
  closing: boolean,
): Promise<void> {
  const failure = approvedStatusFailure(
    await projectStatuses(tx, projectId),
    target,
    closing,
  );
  if (failure) throw new ApprovalFailure(failure);
}
