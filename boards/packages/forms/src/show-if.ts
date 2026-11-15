import type { AnswerMap } from "./answers";
import type { FormTemplate } from "./schema";

interface RuleNode {
  id: string;
  showIf?: { field: string; equals?: unknown };
}

/**
 * The first cycle of display rules as ids, the first id repeated at the end
 * (`["a", "b", "a"]`), or null. A field has at most one rule, so the rules
 * form a graph with one edge per node and the walk is linear.
 */
export function findShowIfCycle(fields: readonly RuleNode[]): string[] | null {
  const next = new Map<string, string | undefined>();
  for (const field of fields) {
    if (!next.has(field.id)) next.set(field.id, field.showIf?.field);
  }
  const done = new Set<string>();
  for (const field of fields) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let id: string | undefined = field.id;
    while (id !== undefined && next.has(id) && !done.has(id)) {
      if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
      onPath.add(id);
      path.push(id);
      id = next.get(id);
    }
    for (const seen of path) done.add(seen);
  }
  return null;
}

/**
 * The ids of the fields the person sees. A field is hidden if its rule's
 * field is hidden or the answer to it is not `equals`. A field caught in a
 * cycle is hidden (a valid template has none).
 */
export function visibleFieldIds(
  template: Pick<FormTemplate, "fields">,
  answers: AnswerMap,
): Set<string> {
  const byId = new Map(template.fields.map((field) => [field.id, field]));
  const memo = new Map<string, boolean>();
  const isVisible = (id: string): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, false);
    const rule = byId.get(id)?.showIf;
    const visible =
      !rule ||
      (byId.has(rule.field) &&
        isVisible(rule.field) &&
        answers[rule.field]?.v === rule.equals);
    memo.set(id, visible);
    return visible;
  };
  const visible = new Set<string>();
  for (const field of template.fields) {
    if (isVisible(field.id)) visible.add(field.id);
  }
  return visible;
}
