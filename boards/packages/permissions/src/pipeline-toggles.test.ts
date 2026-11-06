import { describe, expect, it } from "vite-plus/test";
import {
  defaultPipelineSettings,
  isPipelineEnabled,
  normalizePipelineSettings,
  PIPELINE_TOGGLE_NAMES,
} from "./pipeline-toggles";

describe("pipeline toggles", () => {
  it("defaults every toggle on except the paid Claude judge", () => {
    const settings = defaultPipelineSettings();
    expect(settings.automation).toBe(true);
    const off = PIPELINE_TOGGLE_NAMES.filter((n) => !settings.toggles[n]);
    expect(off).toEqual(["abJudgeClaude"]);
  });

  it("keeps known stored values, drops unknown keys and fills missing ones", () => {
    const settings = normalizePipelineSettings({
      automation: true,
      toggles: { swarm: false, removedToggle: false, cardAutofill: "no" },
    });
    expect(settings.toggles.swarm).toBe(false);
    expect(settings.toggles.cardAutofill).toBe(true);
    expect("removedToggle" in settings.toggles).toBe(false);
  });

  it("the master switch turns everything off without losing values", () => {
    const settings = normalizePipelineSettings({
      automation: false,
      toggles: { swarm: true },
    });
    expect(isPipelineEnabled(settings, "swarm")).toBe(false);
    expect(settings.toggles.swarm).toBe(true);
    expect(normalizePipelineSettings(null)).toEqual(defaultPipelineSettings());
  });
});
