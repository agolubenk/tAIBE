import { render } from "@react-email/render";
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";
import PasskeyAddedEmail, {
  passkeyAddedSubject,
  passkeyDisplayName,
} from "./passkey-added";

const LINK = "https://kaneo.example/account/passkey-alert#t=row.secret";

describe("PasskeyAddedEmail (TB-31 R-6)", () => {
  it("names the key and links «This wasn't me» with the server's TTL", async () => {
    const html = await render(
      createElement(PasskeyAddedEmail, {
        keyName: "iCloud Keychain",
        alertLink: LINK,
        days: 7,
      }),
    );
    expect(html).toContain("iCloud Keychain");
    expect(html).toContain(LINK);
    expect(html).toContain("This wasn&#x27;t me");
    expect(html).toContain("The link works for 7 days.");
  });

  it("calls a key without a name by its date", async () => {
    const html = await render(
      createElement(PasskeyAddedEmail, {
        keyName: null,
        alertLink: LINK,
        days: 7,
        requestedAt: "2026-11-19T10:00:00.000Z",
      }),
    );
    expect(html).toContain("Passkey from Nov 19, 2026");
  });

  it.each([
    ["en-US", "Passkey from Nov 19, 2026"],
    ["de-DE", "Passkey vom 19. Nov. 2026"],
    ["ja-JP", "2026年11月19日 のパスキー"],
  ])("names an unnamed key in %s", (locale, name) => {
    expect(passkeyDisplayName(null, "2026-11-19T10:00:00.000Z", locale)).toBe(
      name,
    );
  });

  it("keeps the key's own name", () => {
    expect(passkeyDisplayName("YubiKey", new Date(), "de")).toBe("YubiKey");
  });

  it("says why it was sent when the address is known", async () => {
    const html = await render(
      createElement(PasskeyAddedEmail, {
        keyName: "YubiKey",
        alertLink: LINK,
        days: 7,
        email: "maya@example.com",
        instance: "kaneo.example",
      }),
    );
    expect(html).toContain(
      "because a passkey was added to your account on kaneo.example",
    );
  });

  it("puts the key name into the subject", () => {
    expect(passkeyAddedSubject("YubiKey", "en")).toBe(
      "A passkey was added to your Kaneo account: YubiKey",
    );
  });
});
