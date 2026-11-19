import { CHUNK_MAX_CHARS } from "../../../apps/api/src/notebook/chunk/chunk-markdown";

// TB-203: secrets cut by a fixed-length split. Fake values are assembled at
// runtime, so no file holds a key-shaped literal. Values are capitals and
// digits; the filler is Cyrillic.
export const join = (...parts: string[]) => parts.join("");
export const value = (n: number, seed: number) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[(i * 7 + seed * 13 + ((i * i) % 11)) % alphabet.length];
  }
  return out;
};

export const filler = (n: number) => {
  let out = "";
  while (out.length < n) out += "слово ";
  return `${out.slice(0, n - 1)} `;
};

export const DB_VALUE = value(16, 2);
// hardSplit cuts the paragraph at CHUNK_MAX_CHARS, 20 characters into
// `DB_PASSWORD=<value>`: the name and 8 characters of the value stay in the
// first chunk, the other 8 open the second.
export const CUT_DOC = `# Граница\n\n${filler(CHUNK_MAX_CHARS - 20)}DB_PASSWORD=${DB_VALUE} ${filler(1800)}`;
export const DB_TAIL = DB_VALUE.slice(8);

const MARKER = /\[REDACTED:[a-z0-9_]+\]/g;

// True if the text shows 4 characters of the value in a row.
export function shows(text: string, secret: string) {
  const shown = text.replace(MARKER, " ");
  for (let i = 0; i + 4 <= secret.length; i++) {
    if (shown.includes(secret.slice(i, i + 4))) return true;
  }
  return false;
}
