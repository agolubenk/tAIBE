import { describe, expect, it } from "vite-plus/test";
import { parseSearchQuery } from "./search-query";

describe("parseSearchQuery", () => {
  it("keeps a text query as typed", () => {
    expect(parseSearchQuery({ q: "лес " })).toEqual({ q: "лес " });
  });

  it("turns a number the router parsed back into text", () => {
    expect(parseSearchQuery({ q: 227 })).toEqual({ q: "227" });
  });

  it("drops empty, blank and non-text values", () => {
    expect(parseSearchQuery({})).toEqual({});
    expect(parseSearchQuery({ q: "  " })).toEqual({});
    expect(parseSearchQuery({ q: { a: 1 } })).toEqual({});
    expect(parseSearchQuery({ q: Number.NaN })).toEqual({});
  });
});
