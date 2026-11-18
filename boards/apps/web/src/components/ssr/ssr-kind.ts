// The kinds of apps/api/src/ssr/corpus.ts (TB-163); an unknown kind from a
// newer server shows as it comes.
export const SSR_KINDS = [
  "skill",
  "rule",
  "agent",
  "genome",
  "prompt",
  "nerve",
  "config",
  "product-prompt",
  "template",
] as const;
export type SsrKind = (typeof SSR_KINDS)[number];
export const isSsrKind = (kind: string): kind is SsrKind =>
  (SSR_KINDS as readonly string[]).includes(kind);
