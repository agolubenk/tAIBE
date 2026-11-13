import { describe, expect, it } from "vite-plus/test";
import { decodeWire } from "./wire-format.js";
import { hashValue } from "./hash-value.js";
import { shapeResult } from "./shape-result.js";

const data = {
  items: [
    {
      id: "t1",
      title: "One",
      description: "a",
      updatedAt: "2026-10-27T09:00:00.000Z",
    },
    {
      id: "t2",
      title: "Two",
      description: "b",
      updatedAt: "2026-10-27T11:00:00.000Z",
    },
  ],
};

function body(result: ReturnType<typeof shapeResult>) {
  const first = result.content[0];
  return decodeWire(first?.type === "text" ? first.text : "null");
}

describe("shapeResult", () => {
  it("answers in TOON unless the caller asks for JSON (R-033)", () => {
    const toon = shapeResult(data, {}, "list_tasks {}").content[0];
    const json = shapeResult(data, { format: "json" }, "x").content[0];

    expect(toon?.type === "text" && toon.text.startsWith("{")).toBe(false);
    expect(JSON.parse(json?.type === "text" ? json.text : "null")).toEqual({
      etag: hashValue(data),
      untrusted: true,
      data,
    });
  });

  it("answers the data with its etag", () => {
    const result = shapeResult(data, {}, "list_tasks {}");

    expect(result.isError).toBe(false);
    expect(body(result)).toEqual({
      etag: hashValue(data),
      untrusted: true,
      data,
    });
  });

  it("answers no body when the etag still matches", () => {
    const etag = hashValue(data);

    expect(body(shapeResult(data, { ifNoneMatch: etag }, "x"))).toEqual({
      unchanged: true,
      etag,
    });
  });

  it("applies since and fields, keeping the etag of the whole answer", () => {
    const result = shapeResult(
      data,
      { since: "2026-10-27T10:00:00.000Z", fields: ["title"] },
      "list_tasks {}",
    );

    expect(body(result)).toEqual({
      etag: hashValue(data),
      untrusted: true,
      data: { items: [{ id: "t2", title: "Two" }] },
    });
  });
});
