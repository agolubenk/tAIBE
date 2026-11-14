import { describe, expect, it } from "vite-plus/test";
import { encodeEmbedding } from "../embed/embedding-codec";
import {
  buildVectorIndex,
  evictOverBudget,
  indexedChunks,
  nearestChunks,
  VECTOR_BYTES_MAX,
  type VectorIndex,
  vectorRowsMax,
} from "./vector-index";

const row = (id: string, vector: number[]) => ({
  id,
  embedding: encodeEmbedding(vector),
});

describe("vector index", () => {
  it("ranks chunks by cosine to the query", () => {
    const index = buildVectorIndex("s", [
      row("east", [1, 0]),
      row("north", [0, 5]),
      row("northeast", [3, 3]),
    ]);
    expect(index?.dims).toBe(2);
    const hits = nearestChunks(index!, new Float32Array([0.1, 1]), 2);
    expect(hits.map(({ id }) => id)).toEqual(["north", "northeast"]);
    expect(hits[0]?.score).toBeCloseTo(0.995, 3);
  });

  it("leaves out rows of another width and refuses a mismatched query", () => {
    const index = buildVectorIndex("s", [
      row("a", [1, 0]),
      row("wide", [1, 0, 0]),
      { id: "empty", embedding: null },
    ]);
    expect(index?.ids).toEqual(["a"]);
    expect(nearestChunks(index!, new Float32Array([1, 0, 0]), 5)).toEqual([]);
    expect(buildVectorIndex("s", [{ id: "x", embedding: null }])).toBeNull();
  });

  it("fits the row limit to the vector width", () => {
    expect(vectorRowsMax(768 * 4)).toBe(10_922);
    expect(vectorRowsMax(4096 * 4)).toBe(2048);
    expect(vectorRowsMax(4096 * 4) * 4096 * 4).toBeLessThanOrEqual(
      VECTOR_BYTES_MAX,
    );
    expect(vectorRowsMax(0)).toBeGreaterThan(0);
    expect(vectorRowsMax(VECTOR_BYTES_MAX * 2)).toBe(1);
  });

  it("counts the chunks the index holds against its budget (TB-76)", () => {
    expect(indexedChunks(0, 0)).toBe(0);
    expect(indexedChunks(9028, 768 * 4)).toBe(9028);
    expect(indexedChunks(12_000, 768 * 4)).toBe(10_922);
    expect(vectorRowsMax(2 * 4, 2 * 2 * 4)).toBe(2);
  });

  it("drops the oldest indexes past the byte budget and keeps the newest", () => {
    const sized = (floats: number): VectorIndex => ({
      stamp: "s",
      dims: 1,
      ids: [],
      matrix: new Float32Array(floats),
    });
    const indexes = new Map([
      ["a", sized(10)],
      ["b", sized(10)],
      ["c", sized(10)],
    ]);
    evictOverBudget(indexes, 80);
    expect([...indexes.keys()]).toEqual(["b", "c"]);
    evictOverBudget(indexes, 0);
    expect([...indexes.keys()]).toEqual(["c"]);
  });
});
