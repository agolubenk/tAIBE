import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BOARD_TEXT_MARK } from "./board-text.js";
import { filterSince } from "./filter-since.js";
import { fitToBudget } from "./fit-to-budget.js";
import { hashValue } from "./hash-value.js";
import { selectFields } from "./select-fields.js";
import { summarizeText } from "./summarize-text.js";
import type { ViewOptions } from "./view-options.js";
import { encodeResponse } from "./wire-format.js";

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }], isError: false };
}

// The etag covers the whole API answer, so any change shows up whichever
// fields the caller keeps. A TOON codec failure still answers, in JSON, and
// goes to onFallback for the journal (AC-022).
export function shapeResult(
  data: unknown,
  view: ViewOptions,
  fullRef: string,
  onFallback?: (error: string) => void,
): CallToolResult {
  const etag = hashValue(data);
  const encoded =
    view.ifNoneMatch === etag
      ? encodeResponse({ unchanged: true, etag }, { format: view.format })
      : fitToBudget(
          // TB-83: one mark per answer, not one per item.
          { etag, [BOARD_TEXT_MARK]: true, data: shape(data, view) },
          { budget: view.budget, format: view.format, fullRef },
        );
  if (encoded.fallbackError) onFallback?.(encoded.fallbackError);
  return text(encoded.text);
}

function shape(data: unknown, view: ViewOptions) {
  const shaped = selectFields(filterSince(data, view.since), view.fields);
  return view.summary ? summarizeText(shaped) : shaped;
}
