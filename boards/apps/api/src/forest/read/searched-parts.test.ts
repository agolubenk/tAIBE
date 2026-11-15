import { describe, expect, it } from "vite-plus/test";
import { SEARCH_TEXT_CHARS, searchFields } from "../fell/build-log";
import { searchedParts } from "./searched-parts";

const glued = (fields: string[]) =>
  fields.join("\n").slice(0, SEARCH_TEXT_CHARS);

describe("searchedParts", () => {
  it("gives each field of an uncut searchText on its own", () => {
    const fields = searchFields("Ops Authorization: Bearer", "a\nb", [
      null,
      "comment",
      "",
    ]);
    expect(searchedParts(glued(fields), fields)).toEqual([
      "Ops Authorization: Bearer",
      "a\nb",
      "comment",
    ]);
  });

  it("finds the field after a comment kept shorter than searched", () => {
    // History keeps 4000 characters of a comment; searchText has it whole.
    const whole = `${"long ".repeat(1000)}tail`;
    const kept = whole.slice(0, 4000);
    const searchText = glued(["Title", whole, "next"]);
    expect(searchedParts(searchText, ["Title", kept, "next"])).toEqual([
      "Title",
      kept,
      "next",
    ]);
  });

  it("matches the field that the cut ends only up to its last space", () => {
    // "Cut\n" and 99 996 characters of the description: the cut leaves "se".
    const description = `${"x ".repeat(49_997)}secretpart and more`;
    const fields = ["Cut", description];
    const parts = searchedParts(glued(fields), fields);
    expect(parts).toEqual(["Cut", "x ".repeat(49_996).concat("x")]);
  });

  it("gives no part of a field cut off at a field edge", () => {
    const title = "t".repeat(10);
    const description = "d".repeat(SEARCH_TEXT_CHARS - title.length - 1);
    const fields = [title, description, "after the cut"];
    expect(searchedParts(glued(fields), fields)).toEqual([title, description]);
  });

  it("ends the parts at a field that searchText does not hold", () => {
    expect(
      searchedParts("Title\nold description\nlater", [
        "Title",
        "new description",
        "later",
      ]),
    ).toEqual(["Title"]);
  });
});
