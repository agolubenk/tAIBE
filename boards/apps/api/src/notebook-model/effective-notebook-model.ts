import { normalizeBaseUrl, urlOrigin } from "../notebook/llm/base-url";
import { notebookLlmConfig, readLlmKey } from "../notebook/llm/llm-config";
import { envEmbedModel } from "../notebook/notebook-config";
import { readStoredNotebookModel } from "./notebook-model-store";
import { openSecret } from "./secret-box";

type PointKey = {
  key: string | null;
  // Where the key came from; "settings" wins over the server's key file.
  keySource: "settings" | "file" | null;
  // A key is stored but cannot be opened: the server's settings key or the
  // API address changed since it was saved.
  keyUnreadable: boolean;
  // The server's key file holds a key for the server's own address, and this
  // point's address differs, so the file key is not sent there.
  fileKeyWithheld: boolean;
  // GLM's reasoning switch (`NOTEBOOK_LLM_THINKING`). Like the key file it is
  // set for the server's own address and is not sent to another one.
  thinking: string | null;
};

// TB-159: one place the notebook can send a call to, in the admin's order.
export type ModelPointSettings = PointKey & {
  // "main" for the main point, the stored id for a chain point.
  id: string;
  baseUrl: string;
  model: string | null;
  // OpenRouter's own fallbacks for this point.
  models: string[];
};

// A chain point always names its model.
export type ChainPointSettings = ModelPointSettings & { model: string };

export type NotebookModel = ModelPointSettings & {
  embedModel: string;
  dailyMax: number;
  chain: ChainPointSettings[];
};

// A point that can take a call: it has a model and a key.
export type ModelPoint = {
  id: string;
  baseUrl: string;
  model: string;
  models: string[];
  key: string;
  thinking?: string;
};

export type ModelChain = [ModelPoint, ...ModelPoint[]];

export const MAIN_POINT = "main";

type Env = ReturnType<typeof notebookLlmConfig>;

// The stored key opens only for the address it was sealed to. Without one, the
// server's key file is used for the server's own address and no other.
function pointKey(
  sealed: string | undefined,
  baseUrl: string,
  env: Env,
  fileKey: () => string | null,
): PointKey {
  const origin = urlOrigin(baseUrl);
  const storedKey = sealed ? openSecret(sealed, origin) : null;
  const fileFits = origin === urlOrigin(env.baseUrl);
  const unusedFileKey = storedKey ? null : fileKey();
  const usedFileKey = fileFits ? unusedFileKey : null;
  return {
    key: storedKey ?? usedFileKey,
    keySource: storedKey ? "settings" : usedFileKey ? "file" : null,
    keyUnreadable: Boolean(sealed) && !storedKey,
    fileKeyWithheld: unusedFileKey !== null && !fileFits,
    thinking: fileFits ? (env.thinking ?? null) : null,
  };
}

// The admin's settings first, then the server's environment, then defaults.
export async function effectiveNotebookModel(): Promise<NotebookModel> {
  const stored = await readStoredNotebookModel();
  const env = notebookLlmConfig();
  let fileKey: string | null | undefined;
  const readFileKey = () => {
    if (fileKey === undefined) fileKey = readLlmKey(env.keyFile);
    return fileKey;
  };
  const baseUrl = stored.baseUrl
    ? normalizeBaseUrl(stored.baseUrl)
    : env.baseUrl;
  return {
    id: MAIN_POINT,
    baseUrl,
    model: stored.model ?? env.model,
    models: stored.models ?? [],
    embedModel: stored.embedModel ?? envEmbedModel(),
    dailyMax: stored.dailyMax ?? env.dailyMax,
    ...pointKey(stored.key, baseUrl, env, readFileKey),
    chain: (stored.chain ?? []).map((point): ChainPointSettings => {
      const pointUrl = normalizeBaseUrl(point.baseUrl);
      return {
        id: point.id,
        baseUrl: pointUrl,
        model: point.model,
        models: point.models ?? [],
        ...pointKey(point.key, pointUrl, env, readFileKey),
      };
    }),
  };
}

// The points that can take a call, main first; null when none can.
export function modelChain(settings: NotebookModel): ModelChain | null {
  const points = [settings, ...settings.chain].flatMap(
    ({ id, baseUrl, model, models, key, thinking }): ModelPoint[] =>
      model && key
        ? [
            {
              id,
              baseUrl,
              model,
              models,
              key,
              ...(thinking ? { thinking } : {}),
            },
          ]
        : [],
  );
  const [first, ...rest] = points;
  return first ? [first, ...rest] : null;
}

export async function notebookEmbedModel(): Promise<string> {
  return (await readStoredNotebookModel()).embedModel ?? envEmbedModel();
}
