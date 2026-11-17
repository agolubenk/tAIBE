import { FIELD_TYPES, LIMITS } from "@kaneo/forms";
import { FORM_FIELD_TYPES, FORM_LIMITS } from "@kaneo/mcp/tools";
import { describe, expect, it } from "vite-plus/test";

// TB-173: the MCP form tools keep a short copy of the field types and limits
// (the full template schema would cost every session 10 KB of tools/list).
// The API has both packages, so the copy is checked here.
describe("MCP form tools and @kaneo/forms", () => {
  it("name the same field types", () => {
    expect([...FORM_FIELD_TYPES]).toEqual([...FIELD_TYPES]);
  });

  it("name the same limits", () => {
    for (const [key, value] of Object.entries(FORM_LIMITS)) {
      expect(LIMITS[key as keyof typeof LIMITS], key).toEqual(value);
    }
  });
});
