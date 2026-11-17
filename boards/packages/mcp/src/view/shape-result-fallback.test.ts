import { describe, expect, it, vi } from "vite-plus/test";
import { shapeResult } from "./shape-result.js";

vi.mock("@kaneo/agent-format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kaneo/agent-format")>();
  return {
    ...actual,
    encodeResponse: () => ({
      text: "",
      format: "json",
      fallbackError: "codec broke",
    }),
  };
});

describe("shapeResult codec fallback (AC-022)", () => {
  it("answers compact JSON and reports the codec error", () => {
    const onFallback = vi.fn();

    const result = shapeResult({ id: "t1" }, {}, "get_task {}", onFallback);
    const first = result.content[0];

    expect(JSON.parse(first?.type === "text" ? first.text : "null")).toEqual({
      etag: expect.any(String),
      untrusted: true,
      data: { id: "t1" },
    });
    expect(onFallback).toHaveBeenCalledWith("codec broke");
  });
});
