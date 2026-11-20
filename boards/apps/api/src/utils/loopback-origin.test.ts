import { describe, expect, it } from "vite-plus/test";
import { isLoopbackOrigin } from "./loopback-origin";

describe("isLoopbackOrigin — the development CORS fallback (TB-87)", () => {
  it("accepts pages served from this machine", () => {
    for (const origin of [
      "http://localhost:5173",
      "http://localhost",
      "https://localhost:3000",
      "http://127.0.0.1:1337",
      "http://[::1]:5173",
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(true);
    }
  });

  it("refuses other sites, look-alikes and malformed origins", () => {
    for (const origin of [
      undefined,
      "",
      "null",
      "https://attacker.example",
      "http://localhost.attacker.example",
      "http://attacker.example/localhost",
      "http://127.0.0.2:5173",
      "http://localhost:5173/",
      "file://localhost",
      "chrome-extension://abc",
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(false);
    }
  });
});
