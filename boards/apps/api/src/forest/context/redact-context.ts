import { redact } from "@kaneo/redact";

// TB-141: the context pack goes into the model context of every session that
// reads the card, so its free text is masked on the way out. Stored values do
// not change. Names, ids, enums, numbers and dates are not free text and pass
// through as they are.
const clean = (text: string) => redact(text).text;
const cleanNullable = (text: string | null) =>
  text === null ? null : clean(text);
// jsonb columns are typed, not checked: a value that is not a string passes
// as it is, so one odd row cannot turn the pack into a 500 (redact throws on
// a non-string).
const cleanJson = <T>(value: T): T =>
  typeof value === "string" ? (clean(value) as T) : value;

export function redactContextTask<
  T extends { title: string; description: string | null; labels: string[] },
>(task: T): T {
  return {
    ...task,
    title: clean(task.title),
    description: cleanNullable(task.description),
    labels: task.labels.map(clean),
  };
}

export function redactContextMeta<
  T extends {
    report: string | null;
    executor: string | null;
    branch: string | null;
    pullRequests: string[];
    files: string[];
    contextPack: string | null;
  },
>(meta: T): T {
  return {
    ...meta,
    report: cleanNullable(meta.report),
    executor: cleanNullable(meta.executor),
    branch: cleanNullable(meta.branch),
    pullRequests: meta.pullRequests.map(cleanJson),
    files: meta.files.map(cleanJson),
    contextPack: cleanNullable(meta.contextPack),
  };
}

export function redactContextApproval<
  T extends { reason: string | null; params: Record<string, string> | null },
>(approval: T): T {
  const { params } = approval;
  return {
    ...approval,
    reason: cleanNullable(approval.reason),
    params:
      params === null
        ? null
        : Object.fromEntries(
            Object.entries(params).map(([key, value]) => [
              key,
              cleanJson(value),
            ]),
          ),
  };
}

export function redactContextRelation<T extends { task: { title: string } }>(
  relation: T,
): T {
  return {
    ...relation,
    task: { ...relation.task, title: clean(relation.task.title) },
  };
}

export function redactContextComment<T extends { content: string }>(
  comment: T,
): T {
  return { ...comment, content: clean(comment.content) };
}
