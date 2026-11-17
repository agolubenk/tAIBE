// Sector names carry no "Sector" word: the UI adds the prefix in the user's
// language (workspace:forest.trees.sector). Before TB-221 the detector stored
// "Sector: <root title> +N"; those rows stay in the database, so every reader
// returns the name through sectorName() instead of rewriting the data.
const LEGACY_PREFIX = "Sector: ";

export function detectedSectorName(rootTitle: string, treeCount: number) {
  return `${rootTitle} +${treeCount - 1}`;
}

export function sectorName(stored: string) {
  return stored.startsWith(LEGACY_PREFIX)
    ? stored.slice(LEGACY_PREFIX.length)
    : stored;
}
