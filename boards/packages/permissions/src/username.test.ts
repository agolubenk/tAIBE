import { describe, expect, it } from "vite-plus/test";
import {
  isAllowedUsername,
  isEmailLogin,
  RESERVED_USERNAMES,
  usernameProblem,
} from "./username";

describe("login rule (TB-31 R-1)", () => {
  it("accepts 3 to 30 Latin letters and digits", () => {
    expect(isAllowedUsername("abc")).toBe(true);
    expect(isAllowedUsername("Ivan2026")).toBe(true);
    expect(isAllowedUsername("a".repeat(30))).toBe(true);
  });

  it("names the length problem", () => {
    expect(usernameProblem("ab")).toBe("tooShort");
    expect(usernameProblem("")).toBe("tooShort");
    expect(usernameProblem("a".repeat(31))).toBe("tooLong");
  });

  it("refuses anything but Latin letters and digits", () => {
    for (const value of [
      "ivan.p",
      "ivan_p",
      "ivan-p",
      "иван",
      "ivan p",
      "ivаn",
    ]) {
      expect(usernameProblem(value), value).toBe("invalid");
    }
  });

  it("refuses every reserved name in any case", () => {
    for (const name of RESERVED_USERNAMES) {
      const problem = usernameProblem(name);
      // `t-boards` fails the pattern first; it is refused all the same.
      expect(problem, name).toBe(name.includes("-") ? "invalid" : "reserved");
      expect(isAllowedUsername(name.toUpperCase()), name).toBe(false);
    }
  });

  it("holds the spec's list", () => {
    expect([...RESERVED_USERNAMES].sort()).toEqual(
      [
        "admin",
        "administrator",
        "agent",
        "api",
        "bot",
        "help",
        "kaneo",
        "null",
        "owner",
        "root",
        "security",
        "support",
        "system",
        "t-boards",
        "tboards",
      ].sort(),
    );
  });

  it("sends a value with @ to the email route", () => {
    expect(isEmailLogin("ivan@example.com")).toBe(true);
    expect(isEmailLogin("ivan")).toBe(false);
  });
});
