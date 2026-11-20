import { describe, expect, it } from "vite-plus/test";
import { passkeyOptions } from "./passkey-options";

describe("passkeyOptions (TB-31 R-6)", () => {
  it("binds keys to the client URL's host unless PASSKEY_RP_ID names one", () => {
    const own = passkeyOptions({ KANEO_CLIENT_URL: "https://boards.example" });
    expect(own).toMatchObject({
      rpID: "boards.example",
      origin: "https://boards.example",
    });
    expect(
      passkeyOptions({
        KANEO_CLIENT_URL: "https://boards.example:8443",
        PASSKEY_RP_ID: " example ",
      }),
    ).toMatchObject({ rpID: "example", origin: "https://boards.example:8443" });
    expect(passkeyOptions({})).toMatchObject({
      rpID: "localhost",
      origin: "http://localhost:5173",
    });
  });

  it("asks for a PIN or biometrics on registration and checks both ceremonies", () => {
    const options = passkeyOptions({});
    expect(options.authenticatorSelection?.userVerification).toBe("required");
    expect(options.registration?.afterVerification).toBeTypeOf("function");
    expect(options.authentication?.afterVerification).toBeTypeOf("function");
  });
});
