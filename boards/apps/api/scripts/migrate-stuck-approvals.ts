// TB-102 R-11: «approved» requests that were never spent.
//   tsx scripts/migrate-stuck-approvals.ts --dry-run      list, change nothing
//   tsx scripts/migrate-stuck-approvals.ts                apply; prints the runId
//   tsx scripts/migrate-stuck-approvals.ts --revert <id>  undo that run's steps
// A second run takes only what is left and is safe.
import { randomUUID } from "node:crypto";
import {
  planStuck,
  revertRun,
  runStuck,
} from "../src/forest/approval/migrate-stuck";

async function main() {
  const args = process.argv.slice(2);
  const revertAt = args.indexOf("--revert");
  if (revertAt >= 0) {
    const runId = args[revertAt + 1];
    if (!runId) throw new Error("--revert needs the runId");
    for (const line of await revertRun(runId)) console.log(line);
    return;
  }
  const plans = await planStuck();
  const counts = new Map<string, number>();
  for (const item of plans) {
    const key = `${item.outcome}:${item.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    console.log(
      [
        item.outcome,
        item.reason,
        item.action,
        item.targetId,
        item.approvalId,
        item.workspaceId,
      ].join("\t"),
    );
  }
  console.log(
    `total ${plans.length}: ${[...counts].map(([k, n]) => `${k}=${n}`).join(", ") || "none"}`,
  );
  if (args.includes("--dry-run")) return;
  const runId = randomUUID().slice(0, 8);
  await runStuck(plans, runId);
  console.log(`applied run=${runId}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
