import { redact } from "@kaneo/redact";
import { describe, expect, it } from "vite-plus/test";
import { CHUNK_MAX_CHARS, chunkMarkdown } from "./chunk-markdown";
import { maskChunkEdges, maskPassage } from "./mask-chunk-edges";

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
  // The last line is short (37): base64Blob misses it (TB-203 N4).
  const raw = value(3237, 3, BASE64);
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

// A marker is capitals too, so it is taken out before the check. A run of
// the secret is visible when it is one of the 3-character runs of a shown
// text: one pass over the texts, not one per run of a 3 000-character PEM.
const MARKER = /\[REDACTED:[a-z0-9_]+\]/g;
function visible(texts: string[], secret: string) {
  const shown = new Set<string>();
  for (const text of texts.map((item) => item.replace(MARKER, " "))) {
    for (let i = 0; i + 3 <= text.length; i++) shown.add(text.slice(i, i + 3));
  }
  for (let i = 0; i + 3 <= secret.length; i++) {
    const run = secret.slice(i, i + 3);
    if (!run.includes("\n") && shown.has(run)) return true;
  }
  return false;
}

// The PEM block is read at about 470 cuts, three chunks each: 1 s here and
// 4–7 s on a shared CI runner, over the default 5 s (boards-ci, a8307108f).
const CUTS_TIMEOUT_MS = 30_000;

// The chunks of a paragraph cut by hardSplit with the secret `shift`
// characters before the cut at CHUNK_MAX_CHARS.
function cutAt(secret: string, shift: number) {
  const paragraph = `${filler(Math.max(1, CHUNK_MAX_CHARS - shift))}${secret} ${filler(1800)}`;
  return chunkMarkdown(`# Граница\n\n${paragraph}`);
}

describe("maskChunkEdges (TB-203)", () => {
  it.each(FAMILIES)(
    "masks every cut of a $name at a chunk edge",
    (family) => {
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
    },
    CUTS_TIMEOUT_MS,
  );

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

describe("maskPassage (boards #388 N1)", () => {
  const LABELS = [
    "Authorization: Bearer",
    "Authorization: Bearer ",
    "DB_PASSWORD=",
    "password: ",
    "Staging password:",
    "api_key=",
    "x(",
    " ",
    "\n",
    '"',
  ];
  const secret = value(16, 5);

  // The glue of heading and text read whole, and read again over the text
  // masked first: a value that one of them hides stays hidden.
  it("hides every value that one of the two readings hides", () => {
    let state = 11;
    const pick = <T>(items: readonly T[]): T => {
      state = (state * 48_271) % 2_147_483_647;
      return items[state % items.length] as T;
    };
    const run = (n: number) =>
      Array.from({ length: n }, () => pick(LABELS)).join("");
    let hidden = 0;
    for (let index = 0; index < 5_000; index += 1) {
      const heading = run(pick([1, 2]));
      const text = `${run(pick([1, 2, 3, 4]))}${pick(["", " "])}${secret}`;
      const whole = redact(`${heading}\n\n${text}`).text;
      const again = redact(`${heading}\n\n${maskChunkEdges(text).text}`).text;
      if (whole.includes(secret) && again.includes(secret)) continue;
      hidden += 1;
      expect(maskPassage(heading, text)).not.toContain(secret);
    }
    expect(hidden).toBeGreaterThan(1_000);
  });

  it("hides the value after a label heading and a chain of labels", () => {
    const passage = maskPassage(
      "Authorization: Bearer",
      `Authorization: Bearer DB_PASSWORD=Authorization: Bearer ${secret} для бота`,
    );
    expect(passage).not.toContain(secret);
    expect(passage).toContain("для бота");
  });

  // Claude lens #400 B2: without a heading the passage is the text. The
  // passage before TB-203 read it twice, redact(redact(text).text): a marker
  // lifts the `-` lookaround of a detector, so the second reading finds a
  // token glued to a PEM block.
  it("reads a text without a heading twice, as the passage before TB-203", () => {
    const family = (name: string) =>
      FAMILIES.find((item) => item.name === name) as (typeof FAMILIES)[number];
    const token = family("ghp_ token");
    const jwt = family("JWT");
    const pem = family("PEM block").secret;
    for (const [text, hidden] of [
      [`token ${token.secret}${pem}`, token.value],
      [`${pem}${jwt.secret} хвост`, jwt.value],
    ] as const) {
      expect(redact(redact(text).text).text).not.toContain(hidden);
      expect(maskPassage("", text)).not.toContain(hidden);
    }
  });

  // TB-210 (Claude lens #400, not blocking 1): the glue with the next chunk
  // made a base64 hit of the token's tail. That hit was in the text masked
  // for the second reading, so the second reading did not see the token
  // whole, and the passage showed what redact(redact(text).text) hides.
  it("hides what the text read twice alone hides, whatever the neighbours", () => {
    const end = join("-----END ", "PRIVATE KEY-----");
    const parts = [value(20, 7), value(40, 8), value(19, 9)];
    const jwt = join("ey", "J", parts.join("."));
    const pat = join("github", "_pat_", value(40, 10));
    const next = value(60, 11, BASE64);
    for (const [text, hidden] of [
      [`${end}${jwt}`, parts],
      [`${end}${pat}`, [pat.slice(-40)]],
    ] as const) {
      const twice = redact(redact(text).text).text;
      for (const piece of hidden) expect(twice).not.toContain(piece);
      for (const heading of ["", "Ключи"]) {
        const passage = maskPassage(heading, text, "", next);
        for (const piece of hidden) expect(passage).not.toContain(piece);
      }
    }
  });
});
