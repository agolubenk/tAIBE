// The named entities pages actually use in running text; the rest stay as
// written, which search still matches by the surrounding words.
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  euro: "€",
};

export function decodeEntities(text: string) {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi,
    (match, name) => {
      const entity = String(name).toLowerCase();
      if (!entity.startsWith("#")) return NAMED[entity] ?? match;
      const code = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : match;
    },
  );
}
