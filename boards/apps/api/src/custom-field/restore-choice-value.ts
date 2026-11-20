import { hasRedactionMarker, restoreRedacted } from "@kaneo/redact/restore";
import { ApiError } from "../errors/api-error";
import { type ChoiceType, parseChoiceValue } from "./choice-options";

// TB-178: a caller with a token reads field options masked. It picks an option
// by sending it as it read it. A marker resolves to the stored options that
// mask to the same text: all of them if the count matches, else the task's
// current ones if that count matches. Any other case is ambiguous: 409.
export function restoreChoiceValue(
  value: string,
  type: ChoiceType,
  options: readonly string[],
  storedValue: string | null | undefined,
): string {
  if (type === "dropdown") {
    return resolveMarkers([value.trim()], options, storedValue, type)[0] ?? "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value; // setCustomFieldValue answers 400 for a value that is not JSON.
  }
  if (!Array.isArray(parsed)) return value;
  const items = parsed.filter(
    (item): item is string => typeof item === "string",
  );
  if (items.length !== parsed.length) return value;
  return JSON.stringify(resolveMarkers(items, options, storedValue, type));
}

function resolveMarkers(
  items: readonly string[],
  options: readonly string[],
  storedValue: string | null | undefined,
  type: ChoiceType,
): string[] {
  const current = parseChoiceValue(storedValue ?? null, type);
  const queues = new Map<string, string[]>();
  for (const masked of new Set(items.filter(hasRedactionMarker))) {
    const count = items.filter((item) => item === masked).length;
    const matches = options.filter(
      (option) => restoreRedacted(option, masked).ok,
    );
    const kept = matches.filter((option) => current.includes(option));
    const chosen =
      count === matches.length
        ? matches
        : count === kept.length
          ? kept
          : undefined;
    if (!chosen) throw ambiguous(masked, count, matches.length);
    queues.set(masked, [...chosen]);
  }
  return items.map((item) => queues.get(item)?.shift() ?? item);
}

function ambiguous(masked: string, count: number, matches: number): ApiError {
  return new ApiError(409, {
    code: "REDACTED_MARKERS_MISMATCH",
    message: `"${masked}" is sent ${count} time(s), and ${matches} field option(s) match it. Send the task's value back as you read it, or pick each masked option once; a person picks between options that look the same in the web app.`,
  });
}
