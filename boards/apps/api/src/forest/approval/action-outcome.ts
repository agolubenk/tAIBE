// What applying one «да» changed: a journal row per step (R-6, «было →
// стало») and the events to publish once the transaction commits.
export type AppliedStep = {
  targetType: string;
  targetId: string;
  field: string;
  from: string | null;
  to: string | null;
};

export type ActionOutcome = {
  steps: AppliedStep[];
  publish: () => Promise<void>;
};
