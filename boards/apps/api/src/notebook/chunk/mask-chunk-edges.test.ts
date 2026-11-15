import { redact } from "@kaneo/redact";
import { describe, expect, it } from "vite-plus/test";
import { CHUNK_MAX_CHARS, chunkMarkdown } from "./chunk-markdown";
import { maskChunkEdges } from "./mask-chunk-edges";

// Fake secrets assembled at runtime, so this file holds no key-shaped
// literal. The filler is Cyrillic, so a visible run of 3 characters of a
// value is a piece of it.
const join = (...parts: string[]) => parts.join("");
const CAPITALS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// A PEM body is base64: mixed case, as redact expects of key material.
const BASE64 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ";
const value = (n: number, seed: number, alphabet = CAPITALS) => {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[(i * 7 + seed * 13 + ((i * i) % 11)) % alphabet.length];
  }
  return out;
};
const PEM_BODY = (() => {
  const raw = value(3200, 3, BASE64);
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 64) lines.push(raw.slice(i, i + 64));
  return lines.join("\n");
})();

const FAMILIES: { name: string; secret: string; value: string }[] = [
  { name: "ghp_ token", secret: join("gh", "p_", value(36, 1)), value: "" },
  { name: "DB_PASSWORD=", secret: `DB_PASSWORD=${value(16, 2)}`, value: "" },
  {
    name: "DB_PASSWORD = ",
    secret: `DB_PASSWORD = ${value(16, 2)}`,
    value: "",
  },
  { name: "password: ", secret: `password: ${value(16, 2)}`, value: "" },
  {
    name: "database URL",
    secret: `DATABASE_URL=${join("postgres", "://app:")}${value(11, 4)}@db.internal:5432/app`,
    value: value(11, 4),
  },
  {
    name: "Bearer header",
    secret: `Authorization: Bearer ${value(32, 6)}`,
    value: "",
  },
  {
    name: "JWT",
    secret: join("ey", "J", value(20, 7), ".", value(40, 8), ".", value(19, 9)),
    value: "",
  },
  {
    name: "PEM block",
    secret: `${join("-----BEGIN ", "RSA PRIVATE KEY-----")}\n${PEM_BODY}\n${join("-----END ", "RSA PRIVATE KEY-----")}`,
    value: PEM_BODY,
  },
].map((family) => ({
  ...family,
  // By default the value is what follows the last space or `=`.
  value: family.value || (family.secret.split(/[ =]/).pop() as string),
}));

const filler = (n: number) => {
  let out = "";
  while (out.length < n) out += "слово ";
  return `${out.slice(0, n - 1)} `;
};

// A marker is capitals too, so it is taken out before the check.
const MARKER = /\[REDACTED:[a-z0-9_]+\]/g;
function visible(texts: string[], secret: string) {
  const shown = texts.map((text) => text.replace(MARKER, " "));
  for (let i = 0; i + 3 <= secret.length; i++) {
    const run = secret.slice(i, i + 3);
    if (run.includes("\n")) continue;
    if (shown.some((text) => text.includes(run))) return true;
  }
  return false;
}

// The chunks of a paragraph cut by hardSplit with the secret `shift`
// characters before the cut at CHUNK_MAX_CHARS.
function cutAt(secret: string, shift: number) {
  const paragraph = `${filler(Math.max(1, CHUNK_MAX_CHARS - shift))}${secret} ${filler(1800)}`;
  return chunkMarkdown(`# Граница\n\n${paragraph}`);
}

describe("maskChunkEdges (TB-203)", () => {
  it.each(FAMILIES)("masks every cut of a $name at a chunk edge", (family) => {
    const step = family.secret.length > 400 ? 7 : 1;
    let cut = 0;
    let leakedAlone = 0;
    for (let shift = 1; shift < family.secret.length; shift += step) {
      const chunks = cutAt(family.secret, shift);
      const alone = chunks.map((chunk) => redact(chunk.text).text);
      const masked = chunks.map(
        (chunk, i) =>
          maskChunkEdges(
            chunk.text,
            chunks[i - 1]?.text ?? "",
            chunks[i + 1]?.text ?? "",
          ).text,
      );
      cut++;
      if (visible(alone, family.value)) leakedAlone++;
      expect(visible(masked, family.value), `shift ${shift}`).toBe(false);
    }
    // Not vacuous: each chunk masked alone shows a piece of the value.
    expect(leakedAlone).toBeGreaterThan(cut / 4);
  });

  it("keeps a chunk's own hits when the glue hides them", () => {
    // `x` glued before `ghp_…` breaks the word boundary of the key pattern.
    const token = join("gh", "p_", value(36, 1));
    const masked = maskChunkEdges(`${token} конец`, "начало x");
    expect(masked).toEqual({ text: "[REDACTED:api_key] конец", hidden: true });
  });

  it("masks a chunk with no neighbours as redact does", () => {
    const text = `ключ ${join("gh", "p_", value(36, 1))} и слово`;
    expect(maskChunkEdges(text)).toEqual({
      text: redact(text).text,
      hidden: true,
    });
    expect(maskChunkEdges("слово", "слово", "слово")).toEqual({
      text: "слово",
      hidden: false,
    });
  });
});
