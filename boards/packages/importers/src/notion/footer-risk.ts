import type { NotionPropertyValue } from "./api-types.js";

// The footer carries free text from Notion (Очередь holds up to 159 chars)
// past the field mapping, so a value that looks personal or like a signed
// file link stays behind and goes to the report instead (lens 4, 30.10).
const RISKS = [
  /\S+@\S+\.\w+/, // email
  /(?:^|\s)@[\p{L}\d_.]+/u, // @handle
  // A phone or account number, written with or without separators.
  /\+?\d(?:[\s().-]?\d){6,}/,
  /https?:\/\//i,
  /X-Amz-Signature|prod-files-secure|file\.notion\.so\/f\/|secure\.notion-static\.com/i,
];
// A date is eight digits with dashes, not a phone number.
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g;
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
  const text = String(value).replace(ISO_DATE, " ");
  return RISKS.some((risk) => risk.test(text));
}
