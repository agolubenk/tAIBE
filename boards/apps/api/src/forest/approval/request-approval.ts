import db from "../../database";
import { ownerApprovalTable } from "../../database/forest-schema";
import type { ForestActor } from "../actor";
import { writeJournal } from "../journal";
import {
  APPROVAL_TTL_HOURS,
  type ApprovalAction,
  approvalParamsHash,
} from "./approval-params";

export async function requestApproval({
  workspaceId,
  action,
  targetType,
  targetId,
  items,
  params,
  reason,
  actor,
  doneRef = null,
  doneReason = null,
}: {
  workspaceId: string;
  action: ApprovalAction;
  targetType: "task" | "sector" | "workspace" | "label";
  targetId: string;
  // What the hash binds: tree ids for a felling, the value for a task action.
  items: string[];
  params?: Record<string, string>;
  reason: string;
  actor: ForestActor;
  doneRef?: string | null;
  doneReason?: string | null;
}) {
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_HOURS * 3600 * 1000);
  return db.transaction(async (tx) => {
    const [approval] = await tx
      .insert(ownerApprovalTable)
      .values({
        workspaceId,
        action,
        targetType,
        targetId,
        paramsHash: approvalParamsHash(action, targetId, items),
        params: params ?? null,
        reason,
        doneRef,
        doneReason,
        requestedByKind: actor.kind,
        requestedById: actor.id,
        requestedByName: actor.name,
        expiresAt,
      })
      .returning();
    if (!approval) throw new Error("approval insert returned no row");
    await writeJournal(
      {
        workspaceId,
        actor,
        action: "approval.requested",
        targetType,
        targetId,
        outcome: "allowed",
        detail: `approval ${approval.id} ${action}`,
      },
      tx,
    );
    return approval;
  });
}
