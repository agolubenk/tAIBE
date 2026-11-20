import { render } from "@react-email/render";
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";
import ReauthCodeEmail, { reauthCodeSubject } from "./reauth-code";

describe("ReauthCodeEmail (TB-31 R-5)", () => {
  it("renders the code and the lifetime the server passes", async () => {
    const html = await render(
      createElement(ReauthCodeEmail, { code: "123456", minutes: 10 }),
    );
    expect(html).toContain("123456");
    expect(html).toContain("Confirm it&#x27;s you");
    expect(html).toContain("This code expires in 10 minutes.");
    // Not the sign-in copy: this code does not sign anyone in.
    expect(html).not.toContain("Sign in to Kaneo");
  });

  it.each([
    ["en-US", "This code expires in 10 minutes."],
    ["de-DE", "Dieser Code läuft in 10 Minuten ab."],
    ["vi-VN", "Mã này sẽ hết hạn sau 10 phút."],
    ["ja-JP", "このコードの有効期限は10分です。"],
    ["zh-TW", "此驗證碼將在 10 分鐘後失效。"],
  ])("describes the expiry in %s", async (locale, expiry) => {
    const html = await render(
      createElement(ReauthCodeEmail, { code: "123456", minutes: 10, locale }),
    );
    expect(html).toContain(expiry);
  });

  it("says why it was sent when the address is known", async () => {
    const html = await render(
      createElement(ReauthCodeEmail, {
        code: "482913",
        minutes: 10,
        email: "maya@example.com",
        instance: "kaneo.example",
      }),
    );
    expect(html).toContain("maya@example.com");
    expect(html).toContain("asked to confirm it");
  });

  it("puts the code in a subject in the user's language", () => {
    expect(reauthCodeSubject("123456", "de-DE")).toBe(
      "123456 ist dein Kaneo-Bestätigungscode",
    );
    expect(reauthCodeSubject("123456", null)).toBe(
      "123456 is your Kaneo confirmation code",
    );
  });
});
