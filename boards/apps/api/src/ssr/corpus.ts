// SSR corpus: which repo paths belong to the registry and what kind each is.
// The allowlist is the guard for push-back too — a changeset with a path
// outside it aborts the push (spec RU-9), so the list lives once.
export type SsrKind =
  | "skill"
  | "rule"
  | "agent"
  | "genome"
  | "prompt"
  | "nerve"
  | "config"
  | "product-prompt"
  | "template";

type Matcher = {
  kind: SsrKind;
  pattern: RegExp;
  name: (path: string) => string;
};

// The eval tree sits at `supertick-eval/` in the incubator host and at `eval/` in
// the product home; the registry reads whichever checkout the Mac sync points at.
const CORPUS: Matcher[] = [
  {
    kind: "skill",
    pattern: /^\.claude\/skills\/[^/]+\/.+/,
    name: (path) => path.split("/")[2] ?? path,
  },
  {
    kind: "rule",
    pattern: /^\.claude\/rules\/[^/]+$/,
    name: (path) => baseName(path),
  },
  {
    kind: "agent",
    pattern: /^\.claude\/agents\/[^/]+$/,
    name: (path) => baseName(path),
  },
  {
    kind: "genome",
    pattern: /^(?:supertick-eval|eval)\/pipeline\/genome\/.+/,
    name: (path) =>
      path.replace(/^(?:supertick-eval|eval)\/pipeline\/genome\//, ""),
  },
  {
    kind: "prompt",
    pattern: /^(?:supertick-eval|eval)\/prompts\/.+/,
    name: (path) => path.replace(/^(?:supertick-eval|eval)\/prompts\//, ""),
  },
  {
    kind: "nerve",
    pattern: /^(?:supertick-eval|eval)\/nerve\/.+/,
    name: (path) => path.replace(/^(?:supertick-eval|eval)\/nerve\//, ""),
  },
  {
    kind: "config",
    pattern: /^infra\/ai-council\/config\.toml$/,
    name: () => "ai-council",
  },
  {
    kind: "product-prompt",
    pattern: /^apps\/backend\/src\/modules\/ai\/(prompts|prompt-templates)\/.+/,
    name: (path) =>
      path
        .replace("apps/backend/src/modules/ai/", "")
        .replace(/\.(ts|md)$/, ""),
  },
  // R-060 (TB-163): task-folder templates (.ai/templates/brief.md …), read by
  // name without the extension.
  {
    kind: "template",
    pattern: /^\.ai\/templates\/[^/]+$/,
    name: (path) => baseName(path).replace(/\.[^.]+$/, ""),
  },
];

function baseName(path: string): string {
  const cut = path.substring(path.lastIndexOf("/") + 1);
  return cut.length > 0 ? cut : path;
}

export function matchCorpusPath(path: string): Matcher | null {
  return CORPUS.find((matcher) => matcher.pattern.test(path)) ?? null;
}

// The entity a corpus file belongs to: a skill folds into its folder entity,
// every other file is its own entity (D-008).
export function entityOfPath(path: string): {
  kind: SsrKind;
  name: string;
  path: string;
} | null {
  const matcher = matchCorpusPath(path);
  if (!matcher) return null;
  if (matcher.kind === "skill") {
    return {
      kind: "skill",
      name: matcher.name(path),
      path: path.split("/").slice(0, 3).join("/"),
    };
  }
  return { kind: matcher.kind, name: matcher.name(path), path };
}

export function isCorpusPath(path: string): boolean {
  return matchCorpusPath(path) !== null;
}
