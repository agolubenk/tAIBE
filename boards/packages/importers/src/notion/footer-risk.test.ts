import { describe, expect, it } from "vite-plus/test";
import type { NotionPropertyValue, NotionRichText } from "./api-types.js";
import { footerRisk } from "./footer-risk.js";

const text = (...parts: NotionRichText[]) =>
  ({ id: "q", type: "rich_text", rich_text: parts }) as NotionPropertyValue;

describe("footerRisk", () => {
  it.each([
    "ann@example.com",
    "ask @ann_k",
    "+375 291234567",
    "+375 (29) 123-45-67",
    "1234 567",
    "see https://example.com",
    "https://prod-files-secure.s3.amazonaws.com/x?X-Amz-Signature=1",
    "file.notion.so/f/abc",
    // Not dates: the rest after a date, a month 34, no edge, spaces.
    "20123456",
    "291234567",
    "+375 29 123-45-67",
    "20250115-1234567",
    "15.01.2025 1234567",
    "+37520250115",
    "Д20250115",
    "2025 01 15",
    "+375 2912-34-56",
    "2026-10-30T1234567",
  ])("holds back %s", (value) => {
    expect(footerRisk(value, undefined)).toBe(true);
  });

  it.each([
    "w-n-ats-all · ATS и кандидаты: задачи — без срока",
    "T-12",
    "до 2026-10-30",
    "с 2026-10-30T21:39:00.000Z",
    "30.10.2026",
    "срок 1.1.2026, потом 20261030",
    "20261030-213900-0001",
    "Ошибка 20261030-213900",
    "B-1234",
    " FIX-07 ",
    87.5,
    0.72,
  ])("keeps %s", (value) => {
    expect(footerRisk(value, undefined)).toBe(false);
  });

  it("holds back text with a user mention, whatever it reads", () => {
    const property = text(
      { plain_text: "Ann", type: "mention", mention: { type: "user" } },
      { plain_text: " — owner" },
    );
    expect(footerRisk("Ann — owner", property)).toBe(true);
  });

  it("holds back any value of a personal field type", () => {
    const property = {
      id: "e",
      type: "email",
      email: "x",
    } as unknown as NotionPropertyValue;
    expect(footerRisk("x", property)).toBe(true);
  });

  it("keeps a page mention", () => {
    const property = text({
      plain_text: "Roadmap",
      type: "mention",
      mention: { type: "page" },
    });
    expect(footerRisk("Roadmap", property)).toBe(false);
  });
});
