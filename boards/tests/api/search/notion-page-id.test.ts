import { describe, expect, it } from "vite-plus/test";
import { notionPageIdOf } from "../../../apps/api/src/search/notion-page-id";

const ID = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";

// TB-91: a session that holds a Notion id finds the card in one search.
describe("notionPageIdOf", () => {
  it("reads the id with dashes, without them and in any case", () => {
    expect(notionPageIdOf(ID)).toBe(ID);
    expect(notionPageIdOf(ID.replaceAll("-", ""))).toBe(ID);
    expect(notionPageIdOf(` ${ID.toUpperCase()} `)).toBe(ID);
  });

  it("reads the id at the end of a Notion link", () => {
    expect(
      notionPageIdOf(
        `https://www.notion.so/team/Release-plan-${ID.replaceAll("-", "")}?pvs=4`,
      ),
    ).toBe(ID);
    expect(
      notionPageIdOf(`https://www.notion.so/${ID.replaceAll("-", "")}#abc`),
    ).toBe(ID);
  });

  it("does not read other text as an id", () => {
    expect(notionPageIdOf("DEP-23")).toBeNull();
    expect(notionPageIdOf("login bug")).toBeNull();
    expect(notionPageIdOf(ID.replaceAll("-", "").slice(1))).toBeNull();
    expect(notionPageIdOf(`a${ID.replaceAll("-", "")}`)).toBeNull();
    expect(notionPageIdOf(`${ID} and more`)).toBeNull();
  });
});
