import type { NotionPropertyValue } from "./api-types.js";

// The footer carries free text from Notion (Очередь holds up to 159 chars)
// past the field mapping, so a value that looks personal or like a signed
// file link stays behind and goes to the report instead (lens 4, 30.10).
// Digits are [0-9] and edges are Unicode-aware, so the reconciliation's
// Python reads every pattern the same way (role 1, 30.10).
const RISKS = [
  /\S+@\S+\.\w+/, // email
  /(?:^|\s)@[\p{L}0-9_.]+/u, // @handle
  // A phone or account number, written with or without separators. It has
  // no edges on purpose: "ID1234567" is held back too.
  /\+?[0-9](?:[\s().-]?[0-9]){6,}/,
  /https?:\/\//i,
  /X-Amz-Signature|prod-files-secure|file\.notion\.so\/f\/|secure\.notion-static\.com/i,
];

// Dates are digits too, but not a phone number. They are cut, with ranges,
// from a copy used for the check only, and the rest still goes through the
// rules above. `\b` would take the date out of "Д20250115", so the edges
// are Unicode-aware. A date with a digit or `+` next to it across any run of
// separators stays: in "+49 30 20250115" it is the end of a phone number.
const YEAR = "20[0-9]{2}";
const MONTH = "(?:0[1-9]|1[0-2])";
const DAY = "(?:0[1-9]|[12][0-9]|3[01])";
const HOUR = "(?:[01][0-9]|2[0-3])";
const MINUTE = "[0-5][0-9]";
const DATE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${[
    // 2026-10-30, 2026-10-30T21:39:00.000Z
    `${YEAR}-${MONTH}-${DAY}(?:T${HOUR}:${MINUTE}(?::${MINUTE}(?:\\.[0-9]{1,3})?)?(?:Z|[+-]${HOUR}:${MINUTE})?)?`,
    // 30.10.2026, 1.1.2026
    `(?:0?[1-9]|[12][0-9]|3[01])\\.(?:0?[1-9]|1[0-2])\\.${YEAR}`,
    // 20261030, 20261030-213900, 20261030-213900-0001 (owner queue ids)
    `${YEAR}${MONTH}${DAY}(?:-${HOUR}${MINUTE}${MINUTE}(?:-[0-9]{4})?)?`,
  ].join("|")})(?![\\p{L}\\p{N}_])`,
  "gu",
);
const SEPARATOR = /[\s().-]/;
const JOINS = /[0-9+]/;

function withoutDates(text: string): string {
  return text.replace(DATE, (date, offset: number) => {
    let before = offset - 1;
    while (before >= 0 && SEPARATOR.test(text.charAt(before))) before -= 1;
    let after = offset + date.length;
    while (after < text.length && SEPARATOR.test(text.charAt(after))) {
      after += 1;
    }
    const joined =
      JOINS.test(text.charAt(before)) || /[0-9]/.test(text.charAt(after));
    return joined ? date : " ";
  });
}
const PERSONAL_TYPES = new Set(["email", "phone_number", "people"]);

export function footerRisk(
  value: string | number,
  property: NotionPropertyValue | undefined,
): boolean {
  const mentionsUser =
    property?.type === "rich_text" &&
    (property.rich_text ?? []).some(
      (part) => part.type === "mention" && part.mention?.type === "user",
    );
  if (mentionsUser || PERSONAL_TYPES.has(property?.type ?? "")) return true;
  const rest = withoutDates(String(value));
  return RISKS.some((risk) => risk.test(rest));
}
