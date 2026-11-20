import { cloudCallsByModelToday } from "../notebook/chat/call-budget";
import { failsSinceStart } from "../notebook/chat/call-model";
import {
  effectiveNotebookModel,
  type ModelPointSettings,
} from "./effective-notebook-model";
import { canSealSecrets } from "./secret-box";
import { usageByWorkspace } from "./usage-by-workspace";

// A model name counts for the first point that lists it, in the chain's order.
function callsByPoint(
  points: ModelPointSettings[],
  byModel: Map<string, number>,
): Map<string, number> {
  const owner = new Map<string, string>();
  for (const point of points) {
    for (const name of [point.model, ...point.models]) {
      if (name && !owner.has(name)) owner.set(name, point.id);
    }
  }
  const calls = new Map<string, number>();
  for (const [name, count] of byModel) {
    const id = owner.get(name);
    if (id) calls.set(id, (calls.get(id) ?? 0) + count);
  }
  return calls;
}

export async function notebookModelView() {
  const [settings, byModel, usage] = await Promise.all([
    effectiveNotebookModel(),
    cloudCallsByModelToday(),
    usageByWorkspace(),
  ]);
  const pointCalls = callsByPoint([settings, ...settings.chain], byModel);
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    models: settings.models,
    embedModel: settings.embedModel,
    dailyMax: settings.dailyMax,
    hasKey: settings.key !== null,
    keySource: settings.keySource,
    keyUnreadable: settings.keyUnreadable,
    fileKeyWithheld: settings.fileKeyWithheld,
    canStoreKey: canSealSecrets(),
    callsToday: [...byModel.values()].reduce((sum, n) => sum + n, 0),
    pointCallsToday: pointCalls.get(settings.id) ?? 0,
    failsSinceStart: failsSinceStart(settings.id),
    chain: settings.chain.map((point) => ({
      id: point.id,
      baseUrl: point.baseUrl,
      model: point.model,
      models: point.models,
      hasKey: point.key !== null,
      keySource: point.keySource,
      keyUnreadable: point.keyUnreadable,
      fileKeyWithheld: point.fileKeyWithheld,
      callsToday: pointCalls.get(point.id) ?? 0,
      failsSinceStart: failsSinceStart(point.id),
    })),
    usage,
  };
}
