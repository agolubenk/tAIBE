import { createHash } from "node:crypto";
import type { FelledTask, TreeMaterial } from "./tree-material";

export const SEED_COMPRESSOR = "deterministic-v1";
export const SEED_BODY_CHARS = 6000;
const DESCRIPTION_CHARS = 800;
const COMMENT_CHARS = 300;
const COMMENTS_PER_BRANCH = 5;
export const SEED_TRUNCATED =
  "\n\n…[truncated at felling; branches are not restored]";

export type SeedDraft = {
  kind: "branch" | "links";
  title: string;
  body: string;
  sourceTaskIds: string[];
  contentHash: string;
};

type Options = {
  maxBodyChars?: number;
  // Hook for the secret scrubber (packages/redact): seeds are derived text
  // that agents read back, so they must not carry secrets (N-009).
  sanitize?: (text: string) => string;
};

function byNumber(a: FelledTask, b: FelledTask) {
  return (
    (a.number ?? 0) - (b.number ?? 0) ||
    a.createdAt.getTime() - b.createdAt.getTime()
  );
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function fit(body: string, max: number) {
  return body.length > max
    ? body.slice(0, max - SEED_TRUNCATED.length) + SEED_TRUNCATED
    : body;
}

function seed(
  kind: SeedDraft["kind"],
  title: string,
  rawBody: string,
  sourceTaskIds: string[],
  { maxBodyChars = SEED_BODY_CHARS, sanitize = (text) => text }: Options,
): SeedDraft {
  const body = fit(sanitize(rawBody), maxBodyChars);
  return {
    kind,
    title: sanitize(title),
    body,
    sourceTaskIds,
    contentHash: createHash("sha256").update(body).digest("hex"),
  };
}

// One seed per first-level branch: the branch and everything under it,
// flattened into Markdown, plus one seed for links that leave the tree.
export function buildSeeds(
  material: TreeMaterial,
  options: Options = {},
): SeedDraft[] {
  const tasks = new Map(material.tasks.map((task) => [task.id, task]));
  const children = new Map<string, FelledTask[]>();
  for (const { parentId, childId } of material.edges) {
    const child = tasks.get(childId);
    if (!child || childId === material.root.id) continue;
    const list = children.get(parentId) ?? [];
    if (!list.some((t) => t.id === childId)) list.push(child);
    children.set(parentId, list);
  }
  for (const list of children.values()) list.sort(byNumber);

  const seeds: SeedDraft[] = [];
  const seen = new Set<string>([material.root.id]);

  for (const branch of children.get(material.root.id) ?? []) {
    if (seen.has(branch.id)) continue;
    const ids: string[] = [];
    const lines: string[] = [];

    const walk = (task: FelledTask, depth: number) => {
      if (seen.has(task.id)) return;
      seen.add(task.id);
      ids.push(task.id);
      lines.push(`${"  ".repeat(depth)}- ${task.title} — ${task.status}`);
      for (const child of children.get(task.id) ?? []) walk(child, depth + 1);
    };
    walk(branch, 0);

    const comments = material.activities
      .filter(
        (a) => ids.includes(a.taskId) && a.type === "comment" && a.content,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, COMMENTS_PER_BRANCH)
      .map(
        (a) =>
          `- ${clip((a.content ?? "").replace(/\s+/g, " "), COMMENT_CHARS)}`,
      );

    const body = [
      `# ${branch.title}`,
      `status: ${branch.status} · priority: ${branch.priority}`,
      branch.description ? clip(branch.description, DESCRIPTION_CHARS) : "",
      lines.length > 1 ? `## Branches\n${lines.slice(1).join("\n")}` : "",
      comments.length ? `## Discussion\n${comments.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    seeds.push(seed("branch", branch.title, body, ids, options));
  }

  if (material.outerLinks.length > 0) {
    const lines = material.outerLinks.map((link) => {
      const from = tasks.get(link.felledTaskId)?.title ?? link.felledTaskId;
      return link.direction === "out"
        ? `- ${from} —${link.relationType}→ ${link.otherTitle} (${link.otherTaskId})`
        : `- ${link.otherTitle} (${link.otherTaskId}) —${link.relationType}→ ${from}`;
    });
    seeds.push(
      seed(
        "links",
        `Links of ${material.root.title}`,
        `# Links that left the tree\n\n${lines.join("\n")}`,
        [...new Set(material.outerLinks.map((link) => link.felledTaskId))],
        options,
      ),
    );
  }

  return seeds;
}
