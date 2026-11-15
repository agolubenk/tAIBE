import { describe, expect, it } from "vite-plus/test";
import {
  isMarkerQuery,
  matchesVisibleText,
  visibleScore,
} from "./visible-match";

// Fake secrets assembled at runtime, so this file holds no key-shaped literal.
const join = (...parts: string[]) => parts.join("");
const KEY = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const PREFIX = KEY.slice(0, 8);

describe("matchesVisibleText (TB-191)", () => {
  it("finds a query in the text outside secrets, ignoring case", () => {
    expect(matchesVisibleText(`Deploy token ${KEY} today`, "DEPLOY")).toBe(
      true,
    );
    expect(matchesVisibleText(`Deploy token ${KEY} today`, "today")).toBe(true);
  });

  it("does not find a query that is only inside a secret", () => {
    expect(matchesVisibleText(`token ${KEY}`, PREFIX)).toBe(false);
    expect(matchesVisibleText(`token ${KEY}`, PREFIX.toUpperCase())).toBe(
      false,
    );
  });

  it("does not join the text next to a secret to a part of it", () => {
    expect(matchesVisibleText(`token ${KEY}`, `token ${PREFIX}`)).toBe(false);
    expect(matchesVisibleText(`${KEY} done`, `${KEY.slice(-4)} done`)).toBe(
      false,
    );
  });

  it("finds a query that is inside a secret and also outside it", () => {
    expect(matchesVisibleText(`token ${KEY}, prefix ${PREFIX}`, PREFIX)).toBe(
      true,
    );
  });

  it("reads % and _ literally", () => {
    expect(matchesVisibleText("rate 50%", "50%")).toBe(true);
    expect(matchesVisibleText("rate 50 percent", "50%")).toBe(false);
    expect(matchesVisibleText("snake_case", "e_c")).toBe(true);
    expect(matchesVisibleText("snakeXcase", "e_c")).toBe(false);
  });

  it("finds nothing in an empty field", () => {
    expect(matchesVisibleText(null, "x")).toBe(false);
    expect(matchesVisibleText(undefined, "x")).toBe(false);
    expect(matchesVisibleText("", "x")).toBe(false);
  });
});

describe("visibleScore (TB-191)", () => {
  it("gives the score of the first field that matches in its visible text", () => {
    // The stored title matches, but only inside the secret: the description
    // decides, as for a row whose title does not match.
    const fields = [
      [`Key ${KEY}`, 3],
      [`rotate ${PREFIX} soon`, 2],
    ] as const;
    expect(visibleScore(PREFIX, fields)).toBe(2);
    expect(visibleScore("key", fields)).toBe(3);
    expect(visibleScore("absent", fields)).toBeNull();
  });
});

describe("isMarkerQuery (TB-191)", () => {
  it("finds a marker in any case", () => {
    expect(isMarkerQuery("[REDACTED:api_key]")).toBe(true);
    expect(isMarkerQuery("x [redacted:")).toBe(true);
    expect(isMarkerQuery("REDACTED")).toBe(false);
  });
});
