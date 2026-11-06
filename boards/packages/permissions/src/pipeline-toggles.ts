// Automated parts of the team process a product (workspace) can switch off in
// its settings. Each key is enforced where the automation runs: the API for
// card fill, the layer's hooks and tools (`.claude/scripts/pipeline_settings.py`
// reads the same keys — its test checks they match this file). A key that is
// not enforced somewhere must not be listed here.
export const pipelineToggles = {
  // Evolution of the process (eval/evolve, docs: eval/evolve/README.md)
  abJudge: { group: "evolution", default: true },
  // Claude as a judge spends the owner's tokens: off until the owner turns it on.
  abJudgeClaude: { group: "evolution", default: false },
  askOnce: { group: "evolution", default: true },
  handoffDupes: { group: "evolution", default: true },
  evolveAutoMerge: { group: "evolution", default: true },
  // Automatic parts of the pipeline
  promptBrief: { group: "pipeline", default: true },
  successorAuto: { group: "pipeline", default: true },
  grillHint: { group: "pipeline", default: true },
  nerveWakes: { group: "pipeline", default: true },
  swarm: { group: "pipeline", default: true },
  councilReview: { group: "pipeline", default: true },
  cardAutofill: { group: "pipeline", default: true },
} as const satisfies Record<
  string,
  { group: "evolution" | "pipeline"; default: boolean }
>;

export type PipelineToggle = keyof typeof pipelineToggles;

export const PIPELINE_TOGGLE_NAMES = Object.keys(
  pipelineToggles,
) as PipelineToggle[];

export type PipelineSettings = {
  // Master switch: off turns every toggle off without losing their values.
  automation: boolean;
  toggles: Record<PipelineToggle, boolean>;
};

export function defaultPipelineSettings(): PipelineSettings {
  const toggles = {} as Record<PipelineToggle, boolean>;
  for (const name of PIPELINE_TOGGLE_NAMES) {
    toggles[name] = pipelineToggles[name].default;
  }
  return { automation: true, toggles };
}

// Stored settings may predate a toggle or carry a removed one: unknown keys are
// dropped, missing ones take their default.
export function normalizePipelineSettings(value: unknown): PipelineSettings {
  const settings = defaultPipelineSettings();
  if (!value || typeof value !== "object") return settings;
  const raw = value as { automation?: unknown; toggles?: unknown };
  if (typeof raw.automation === "boolean") settings.automation = raw.automation;
  if (raw.toggles && typeof raw.toggles === "object") {
    for (const name of PIPELINE_TOGGLE_NAMES) {
      const v = (raw.toggles as Record<string, unknown>)[name];
      if (typeof v === "boolean") settings.toggles[name] = v;
    }
  }
  return settings;
}

export function isPipelineEnabled(
  settings: PipelineSettings,
  name: PipelineToggle,
): boolean {
  return settings.automation && settings.toggles[name];
}
