// Mac embedding worker for the t-boards notebook. It long-polls the API over
// the tunnel, embeds what it gets with the local Ollama and posts the vectors
// back. One request to Ollama at a time, never in parallel: several inferences
// at once overload this machine.
//   node notebook-worker.mjs         — run forever (the LaunchAgent)
//   node notebook-worker.mjs --once  — one poll round per workspace, then exit
//
// config.workspaceIds lists every notebook this Mac serves. Each workspace
// keeps its own long poll open, because a search waits only a few seconds for
// its query vector (QUERY_EMBED_WAIT_MS) and would fall back to keywords while
// the worker sat in another workspace's poll. The polls only wait on the
// network; the Ollama calls behind them go through one queue.
import { loadConfig, notebookApi, stamp } from "./notebook-client.mjs";

const POLL_WAIT_S = 25;
const BACKOFF_MS = [5_000, 15_000, 60_000];

// nomic-embed-text was trained with task prefixes; other models get raw text.
const PREFIX = { query: "search_query: ", chunk: "search_document: " };
const prefixed = (model, item) =>
  model.startsWith("nomic-embed") ? PREFIX[item.kind] + item.text : item.text;

// Float32 little-endian, as the API stores it (Apple silicon and x86 are LE).
const toBase64 = (vector) =>
  Buffer.from(new Float32Array(vector).buffer).toString("base64");

// First come, first served: a call starts only after the previous one settled.
let ollamaTail = Promise.resolve();
function oneAtATime(task) {
  const run = ollamaTail.then(task, task);
  ollamaTail = run.catch(() => {});
  return run;
}

async function embed(config, model, texts) {
  const response = await fetch(`${config.ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts, keep_alive: "30m" }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`ollama ${model}: HTTP ${response.status} ${detail}`);
  }
  const { embeddings } = await response.json();
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error(`ollama ${model}: expected ${texts.length} embeddings`);
  }
  return embeddings;
}

async function round(config, label) {
  const work = await notebookApi(
    config,
    "GET",
    `/embed/work?wait=${POLL_WAIT_S}`,
    undefined,
    (POLL_WAIT_S + 15) * 1000,
  );
  if (!work.items.length) return 0;
  const vectors = await oneAtATime(() =>
    embed(
      config,
      work.model,
      work.items.map((item) => prefixed(work.model, item)),
    ),
  );
  const saved = await notebookApi(config, "POST", "/embed/results", {
    model: work.model,
    items: work.items.map((item, i) => ({
      kind: item.kind,
      id: item.id,
      embedding: toBase64(vectors[i]),
    })),
  });
  const queries = work.items.filter((item) => item.kind === "query").length;
  console.log(
    `${stamp()}${label} embedded ${work.items.length} (${queries} queries), saved ${saved.saved}, rejected ${saved.rejected}`,
  );
  return work.items.length;
}

async function serve(config, label) {
  let failures = 0;
  for (;;) {
    try {
      await round(config, label);
      failures = 0;
    } catch (error) {
      const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      failures++;
      console.error(
        `${stamp()}${label} ${error.message}; retry in ${delay / 1000}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function main() {
  const config = loadConfig();
  // One workspace keeps the old log lines; several get their id in each line.
  const many = config.workspaceIds.length > 1;
  const targets = config.workspaceIds.map((workspaceId) => ({
    config: { ...config, workspaceId },
    label: many ? ` [${workspaceId}]` : "",
  }));
  if (process.argv.includes("--once")) {
    await Promise.all(
      targets.map(async ({ config: target, label }) => {
        if (!(await round(target, label))) {
          console.log(`${stamp()}${label} no work`);
        }
      }),
    );
    return;
  }
  console.log(
    `${stamp()} worker up: ${config.baseUrl}, ollama ${config.ollamaUrl}` +
      (many ? `, workspaces ${config.workspaceIds.join(", ")}` : ""),
  );
  await Promise.all(
    targets.map(({ config: target, label }) => serve(target, label)),
  );
}

main().catch((error) => {
  console.error(`${stamp()} ${error.message}`);
  process.exit(1);
});
