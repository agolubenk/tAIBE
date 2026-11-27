import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { growth, MAX_GROWTH } from "../fixtures/linear-time.js";
import { redact } from "./index.js";

// TB-266: the names of fixtures/secret-names.json, the same cases as in
// infra/checks/test_checks.py. The key is assembled from fragments.
const names = JSON.parse(
  readFileSync(
    new URL("../fixtures/secret-names.json", import.meta.url),
    "utf8",
  ),
) as { key: string[]; forms: string[]; masked: string[]; quiet: string[] };
const KEY = names.key.join("");

function line(form: string, name: string): string {
  return form.replace("{name}", name).replace("{key}", KEY);
}

function expectMaskedValue(text: string, value: string): void {
  const [before, after] = text.split(value);
  const result = redact(text);
  expect(result.hits).toHaveLength(1);
  expect(result.text).toBe(
    `${before}[REDACTED:${result.hits[0]?.kind ?? "none"}]${after}`,
  );
}

describe("a secret or token name with a prefix or a suffix (TB-266)", () => {
  it.each(
    names.masked.flatMap((name) => names.forms.map((form) => [name, form])),
  )("masks the key under %s in %j", (name, form) => {
    expectMaskedValue(line(form, name), KEY);
  });

  it.each(names.quiet)("leaves code and UI text open: %s", (text) => {
    expect(redact(text)).toEqual({ text, hits: [] });
  });

  // TB-195: "the secret: ..." in prose stays readable.
  it.each(["secret", "Secret", "token", "Token"])(
    "leaves a bare %s open",
    (name) => {
      const text = `${name}: ${KEY}\n`;
      expect(redact(text).text).toBe(text);
    },
  );

  // The filter goes by the last word: a name that ends in secret may hold a
  // passphrase, a name that ends in key or token holds a generated key.
  it.each(["client_secret", "clientSecret", "X-Client-Secret"])(
    "takes a passphrase under %s",
    (name) => {
      expectMaskedValue(
        `${name}=correcthorsebatterystaple\n`,
        "correcthorsebatterystaple",
      );
    },
  );

  it.each(["github_token", "githubToken", "secret_key", "secretKey"])(
    "takes only a generated key under %s",
    (name) => {
      const text = `${name}=correcthorsebatterystaple\n`;
      expect(redact(text).text).toBe(text);
    },
  );

  it("known miss: capitalized words under a lowercase name are open", () => {
    const text = "client_secret=CorrectHorseBatteryStaple\n";
    expect(redact(text).text).toBe(text);
    expectMaskedValue(
      "CLIENT_SECRET=CorrectHorseBatteryStaple\n",
      "CorrectHorseBatteryStaple",
    );
  });

  // Measured on board-agents 4839e42b6: ×3.3–4.6 for a text 4 times longer,
  // at most 21 ms on 256 000 characters (the base: 7 ms).
  it.each(
    [
      "a_secret=",
      "aSecret=",
      "a_token=",
      "aToken:",
      "secret_key=",
      'a_secret:"',
      "a_secret: ",
      "a_secret='",
      "a_secret=a.",
      "a_secret=A",
      "x_secret=!",
      "a_secret=/a/",
    ].flatMap((unit) => ["", "!", '"'].map((end) => [unit, end])),
  )(
    "redacts 256 000 characters of %j and a final %j in linear time",
    (unit, end) => {
      const make = (n: number) => unit.repeat(Math.ceil(n / unit.length)) + end;
      expect(growth(make, redact, 256_000)).toBeLessThan(MAX_GROWTH);
    },
  );
});
