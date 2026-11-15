import { describe, expect, it } from "vite-plus/test";
import { type ChunkGraph, unloadedDeps } from "./preload-deps";

// The entry imports react; the card imports button, which imports cn; the
// lazy forms chunk imports the card, radio and the entry.
const graph: ChunkGraph = {
  "index.js": { imports: ["react.js"], isEntry: true },
  "react.js": { imports: [], isEntry: false },
  "card.js": { imports: ["button.js", "react.js"], isEntry: false },
  "button.js": { imports: ["cn.js"], isEntry: false },
  "cn.js": { imports: [], isEntry: false },
  "forms.js": { imports: ["card.js", "radio.js", "index.js"], isEntry: false },
  "radio.js": { imports: ["cn.js", "dot.js"], isEntry: false },
  "dot.js": { imports: [], isEntry: false },
};

describe("preload list of a dynamic import (TB-173)", () => {
  it("keeps the chunks the page has not loaded and the CSS", () => {
    const deps = [
      "forms.js",
      "card.js",
      "button.js",
      "cn.js",
      "radio.js",
      "dot.js",
      "index.js",
      "react.js",
      "forms.css",
    ];
    expect(unloadedDeps(graph, "card.js", deps)).toEqual([
      "forms.js",
      "radio.js",
      "dot.js",
      "forms.css",
    ]);
  });

  it("keeps the whole list when it does not know the chunks", () => {
    const deps = ["a.js", "a.css"];
    expect(unloadedDeps({}, "card.js", deps)).toEqual(deps);
  });
});
