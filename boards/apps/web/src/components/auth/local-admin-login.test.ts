import { describe, expect, it } from "vite-plus/test";
import {
  isValidSignInLogin,
  LOCAL_ADMIN_EMAIL,
  resolveSignInEmail,
  signInRoute,
} from "./local-admin-login";

describe("resolveSignInEmail", () => {
  it("maps the local admin login to its seeded email", () => {
    expect(resolveSignInEmail("admin")).toBe(LOCAL_ADMIN_EMAIL);
    expect(resolveSignInEmail("  Admin ")).toBe(LOCAL_ADMIN_EMAIL);
  });

  it("passes other logins through trimmed", () => {
    expect(resolveSignInEmail(" user@example.com ")).toBe("user@example.com");
    expect(resolveSignInEmail("administrator")).toBe("administrator");
  });
});

describe("isValidSignInLogin", () => {
  it("accepts emails, the admin alias and logins (TB-31 R-1)", () => {
    expect(isValidSignInLogin("admin")).toBe(true);
    expect(isValidSignInLogin("user@example.com")).toBe(true);
    expect(isValidSignInLogin(" Ivan42 ")).toBe(true);
  });

  it("refuses reserved names, bad logins and bad emails", () => {
    expect(isValidSignInLogin("root")).toBe(false);
    expect(isValidSignInLogin("ivan.k")).toBe(false);
    expect(isValidSignInLogin("ab")).toBe(false);
    expect(isValidSignInLogin("user@")).toBe(false);
    expect(isValidSignInLogin("")).toBe(false);
  });
});

describe("signInRoute", () => {
  it("sends a value with @ and the admin alias to the email route", () => {
    expect(signInRoute("user@example.com")).toBe("email");
    expect(signInRoute(" Admin ")).toBe("email");
    expect(signInRoute("Ivan42")).toBe("username");
  });
});
