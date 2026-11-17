// TB-173 (#357 bundle): for each dynamic import, Vite writes into the
// importing chunk the names of every chunk the imported one reaches, also of
// the chunks the page has already loaded: the entry's chunks and the
// importer's own static imports. Those names cost bytes on every load, and a
// preload of a loaded chunk does nothing. A static import is evaluated before
// its importer runs, so such a chunk is loaded when the dynamic import starts.
// CSS stays: it is not in these sets. A wrong set can only lose a preload,
// never a module: the browser still follows the imported chunk's imports.

export interface GraphChunk {
  imports: readonly string[];
  isEntry: boolean;
}

export type ChunkGraph = Record<string, GraphChunk>;

/** Adds `start` and every chunk it imports statically, directly or not. */
function addClosure(graph: ChunkGraph, start: string, loaded: Set<string>) {
  const stack = [start];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (loaded.has(file)) continue;
    loaded.add(file);
    stack.push(...(graph[file]?.imports ?? []));
  }
}

/** The preload list of a dynamic import without the chunks already loaded. */
export function unloadedDeps(
  graph: ChunkGraph,
  host: string,
  deps: readonly string[],
): string[] {
  const loaded = new Set<string>();
  addClosure(graph, host, loaded);
  for (const [file, chunk] of Object.entries(graph)) {
    if (chunk.isEntry) addClosure(graph, file, loaded);
  }
  return deps.filter((dep) => !loaded.has(dep));
}
