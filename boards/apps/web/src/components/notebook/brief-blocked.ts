import type { NotebookStatus } from "./notebook-types";

// Why the model cannot write a brief right now, as the status knows it; the
// API refuses the same cases on its own.
export function briefBlocked(llm: NotebookStatus["llm"] | undefined) {
  if (!llm) return null;
  if (!llm.configured) return "noModel" as const;
  if (llm.dailyMax !== null && llm.callsToday >= llm.dailyMax) {
    return "capped" as const;
  }
  return null;
}
