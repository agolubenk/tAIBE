import { PASSKEY_ERRORS, PASSKEY_NAME_MAX } from "@kaneo/permissions";
import { describe, expect, it } from "vite-plus/test";
import { assertPasskeyNameFits } from "./passkey-name";

describe("assertPasskeyNameFits (TB-260)", () => {
  it("takes a name of PASSKEY_NAME_MAX after trimming, and no name", () => {
    const fits = "a".repeat(PASSKEY_NAME_MAX);
    expect(() => assertPasskeyNameFits({ name: fits })).not.toThrow();
    expect(() => assertPasskeyNameFits({ name: `  ${fits}\n` })).not.toThrow();
    expect(() => assertPasskeyNameFits({})).not.toThrow();
    expect(() => assertPasskeyNameFits(undefined)).not.toThrow();
    // Not a string: the plugin's schema answers 400 itself.
    expect(() => assertPasskeyNameFits({ name: 42 })).not.toThrow();
  });

  it("refuses one character more with PASSKEY_NAME_TOO_LONG", () => {
    const long = "a".repeat(PASSKEY_NAME_MAX + 1);
    expect(() => assertPasskeyNameFits({ name: long })).toThrow(
      expect.objectContaining({
        statusCode: 400,
        body: expect.objectContaining({ code: PASSKEY_ERRORS.nameTooLong }),
      }),
    );
  });
});
