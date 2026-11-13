import { splitIds } from "./grant-items";

// TB-108: one «да» closes a list of cards. Each card goes to the final column
// of its own project; the request fixes the card list, the status each card
// had when the owner was asked, and the target per project.
export const BATCH_CLOSE_MAX = 250;

// projectId is the card's project when the owner was asked: a card moved to
// another project after the request is not closed (Control lens on #160).
export type BatchCard = {
  id: string;
  projectId: string;
  from: string;
  key: string;
};

export type BatchClose = {
  cards: BatchCard[];
  // projectId → the closing status of that project.
  targets: Map<string, string>;
};

// Statuses and slugs are joined with «,», «;» and «=»: a slug with one of
// them cannot be stored, so the request refuses it.
export const UNSAFE_SLUG = /[,;=]/;

export function batchCloseParams(batch: BatchClose): Record<string, string> {
  return {
    taskIds: batch.cards.map((card) => card.id).join(","),
    projects: batch.cards.map((card) => card.projectId).join(","),
    from: batch.cards.map((card) => card.from).join(","),
    keys: batch.cards.map((card) => card.key).join(","),
    targets: [...batch.targets]
      .map(([projectId, status]) => `${projectId}=${status}`)
      .join(";"),
  };
}

export function isBatchClose(
  action: string,
  params: Record<string, string> | null,
): boolean {
  return action === "close_task" && Boolean(params?.taskIds);
}

// Reads what batchCloseParams wrote; null when the parts do not line up.
export function parseBatchClose(
  params: Record<string, string> | null,
): BatchClose | null {
  const ids = splitIds(params?.taskIds);
  const projects = (params?.projects ?? "").split(",");
  const from = (params?.from ?? "").split(",");
  const keys = (params?.keys ?? "").split(",");
  if (
    ids.length === 0 ||
    from.length !== ids.length ||
    projects.length !== ids.length ||
    projects.some((projectId) => !projectId)
  ) {
    return null;
  }
  const targets = new Map<string, string>();
  for (const pair of (params?.targets ?? "").split(";").filter(Boolean)) {
    const [projectId, status] = pair.split("=");
    if (!projectId || !status) return null;
    targets.set(projectId, status);
  }
  if (targets.size === 0) return null;
  return {
    cards: ids.map((id, index) => ({
      id,
      projectId: projects[index] ?? "",
      from: from[index] ?? "",
      key: keys[index] || id,
    })),
    targets,
  };
}

// What the hash binds: every card with its project and the status the owner
// saw, and every project's target. A card or a target added, dropped or changed needs a new
// «да». Prefixes keep the two kinds apart after sorting.
export function batchCloseItems(batch: BatchClose): string[] {
  return [
    ...batch.cards.map(
      (card) => `task:${card.id}@${card.projectId}:${card.from}`,
    ),
    ...[...batch.targets].map(
      ([projectId, status]) => `target:${projectId}=${status}`,
    ),
  ];
}

// Cards per project for the owner: «APP 104, HRH 46». The key is
// «<slug>-<number>»; a card without a number shows its id and counts as «—».
export function projectCounts(keys: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const dash = key.lastIndexOf("-");
    const slug = dash > 0 ? key.slice(0, dash) : "—";
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([slug, count]) => `${slug} ${count}`)
    .join(", ");
}

// Every key of the request for the owner, one line per project, numbers
// only: «APP: 1, 2, 5». 250 keys fit in about 1 500 characters (R-5,
// Control lens on #160: the owner sees the whole list before «да»).
export function keysByProject(keys: readonly string[]): string {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const dash = key.lastIndexOf("-");
    const slug = dash > 0 ? key.slice(0, dash) : "—";
    const rest = dash > 0 ? key.slice(dash + 1) : key;
    groups.set(slug, [...(groups.get(slug) ?? []), rest]);
  }
  return [...groups]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(
      ([slug, rest]) =>
        `${slug}: ${rest.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).join(", ")}`,
    )
    .join("\n");
}

export type Column = { slug: string; isFinal: boolean; position: number };

// The project's closing target: its first final column that is not «Брёвна»
// (closed takes a card only from done, R-8).
export function finalTarget(columns: readonly Column[]): string | null {
  const final = columns
    .filter((column) => column.isFinal && column.slug !== "closed")
    .sort((a, b) => a.position - b.position)[0];
  return final?.slug ?? null;
}

// Already closed: a final column or the virtual «archived». The owner's
// stage («confirmation») is not closed yet, so a batch may close it.
export function isClosed(columns: readonly Column[], status: string): boolean {
  if (status === "archived") return true;
  return columns.some((column) => column.slug === status && column.isFinal);
}
