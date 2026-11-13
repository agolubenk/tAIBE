// The owner queue takes 120 writes a minute per token, in a sliding 60 s
// window (infra/ops-console/server/queue/throttle.ts). On the VPS one token
// writes for both workspaces, so the 30 s pass and the 5-minute plan run share
// these writes.
export const QUEUE_WRITES_PER_MINUTE = 120;

// One 30 s pass; a minute holds two of them.
export const WRITES_PER_PASS = 50;

// One plan run: what two passes leave of the minute, 120 − 2 × 50 = 20
// (TB-119). The rest of the run's writes go next run.
export const PLAN_WRITES_PER_RUN =
  QUEUE_WRITES_PER_MINUTE - 2 * WRITES_PER_PASS;
