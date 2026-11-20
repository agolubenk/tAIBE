import React from "react";
import { EmailButton } from "../components/email-button";
import { EmailFooter } from "../components/email-footer";
import { EmailIntro } from "../components/email-intro";
import { EmailNote } from "../components/email-note";
import { EmailShell } from "../components/email-shell";
import { FallbackLink } from "../components/fallback-link";
import { formatDate } from "../components/format-date";
import { footerLinks } from "../components/footer-links";
import {
  type RequestContext,
  RequestDetails,
} from "../components/request-details";
import { passkeyAddedReason } from "../components/security-reasons";
import { emailHtmlLang, resolveEmailLocale } from "./resolve-locale";

void React;

/**
 * TB-31 R-6: a passkey was added to the account. «This wasn't me» opens the
 * page that removes the key, the API keys made after it, and every session.
 */
export type PasskeyAddedEmailProps = RequestContext & {
  /** null — the key has no name: the email says «Passkey from <date>». */
  keyName: string | null;
  alertLink: string;
  /** Lifetime of the link in days; the server passes its own TTL. */
  days: number;
  locale?: string | null;
};

const messages = {
  en: {
    preview: (name: string) =>
      `The passkey "${name}" can now sign in to your Kaneo account.`,
    title: "A passkey was added",
    subtitle: (name: string) =>
      `The passkey "${name}" was added to your account. It signs in without a password.`,
    cta: "This wasn't me",
    fallback: "Button not working? Paste this link into your browser:",
    noteTitle: "Was it you?",
    note: (days: number) =>
      `Then there is nothing to do. If it wasn't you, open the link: it removes this key, the API keys made after it, and signs out every session. The link works for ${days} days.`,
    footer: "Kaneo security email",
    unnamed: (date: string) => `Passkey from ${date}`,
  },
  de: {
    preview: (name: string) =>
      `Der Passkey „${name}“ kann sich jetzt bei deinem Kaneo-Konto anmelden.`,
    title: "Ein Passkey wurde hinzugefügt",
    subtitle: (name: string) =>
      `Der Passkey „${name}“ wurde deinem Konto hinzugefügt. Er meldet dich ohne Passwort an.`,
    cta: "Das war ich nicht",
    fallback:
      "Button funktioniert nicht? Füge diesen Link in deinen Browser ein:",
    noteTitle: "Warst du das?",
    note: (days: number) =>
      `Dann ist nichts zu tun. Warst du es nicht, öffne den Link: Er entfernt diesen Passkey und die danach erstellten API-Schlüssel und meldet alle Sitzungen ab. Der Link gilt ${days} Tage.`,
    footer: "Kaneo Sicherheits-E-Mail",
    unnamed: (date: string) => `Passkey vom ${date}`,
  },
  vi: {
    preview: (name: string) =>
      `Khóa truy cập "${name}" giờ có thể đăng nhập vào tài khoản Kaneo của bạn.`,
    title: "Đã thêm một khóa truy cập",
    subtitle: (name: string) =>
      `Khóa truy cập "${name}" đã được thêm vào tài khoản của bạn. Khóa này đăng nhập không cần mật khẩu.`,
    cta: "Không phải tôi",
    fallback: "Nút không hoạt động? Dán liên kết này vào trình duyệt:",
    noteTitle: "Có phải bạn không?",
    note: (days: number) =>
      `Nếu là bạn thì không cần làm gì. Nếu không phải bạn, hãy mở liên kết: nó xóa khóa này, các khóa API tạo sau nó và đăng xuất mọi phiên. Liên kết có hiệu lực trong ${days} ngày.`,
    footer: "Email bảo mật Kaneo",
    unnamed: (date: string) => `Khóa truy cập ngày ${date}`,
  },
  ja: {
    preview: (name: string) =>
      `パスキー「${name}」で Kaneo アカウントにサインインできるようになりました。`,
    title: "パスキーが追加されました",
    subtitle: (name: string) =>
      `パスキー「${name}」があなたのアカウントに追加されました。パスワードなしでサインインできます。`,
    cta: "心当たりがない",
    fallback:
      "ボタンが機能しない場合は、このリンクをブラウザに貼り付けてください：",
    noteTitle: "あなたが追加しましたか？",
    note: (days: number) =>
      `その場合は何もする必要はありません。心当たりがない場合はリンクを開いてください。このパスキーとその後に作成された API キーを削除し、すべてのセッションからサインアウトします。リンクの有効期限は${days}日です。`,
    footer: "Kaneo セキュリティメール",
    unnamed: (date: string) => `${date} のパスキー`,
  },
  "zh-tw": {
    preview: (name: string) =>
      `通行金鑰「${name}」現在可以登入你的 Kaneo 帳號。`,
    title: "已新增通行金鑰",
    subtitle: (name: string) =>
      `通行金鑰「${name}」已新增至你的帳號，可以不用密碼登入。`,
    cta: "不是我",
    fallback: "按鈕無法使用？請將此連結貼到瀏覽器：",
    noteTitle: "是你本人嗎？",
    note: (days: number) =>
      `如果是你，就不需要做任何事。如果不是你，請開啟連結：它會移除這把金鑰與之後建立的 API 金鑰，並登出所有工作階段。連結在 ${days} 天內有效。`,
    footer: "Kaneo 安全性通知",
    unnamed: (date: string) => `${date} 的通行金鑰`,
  },
} as const;

const subjects = {
  en: (name: string) => `A passkey was added to your Kaneo account: ${name}`,
  de: (name: string) => `Neuer Passkey in deinem Kaneo-Konto: ${name}`,
  vi: (name: string) => `Đã thêm khóa truy cập vào tài khoản Kaneo: ${name}`,
  ja: (name: string) => `Kaneo アカウントにパスキーが追加されました：${name}`,
  "zh-tw": (name: string) => `你的 Kaneo 帳號新增了通行金鑰：${name}`,
} as const;

/** The name the email shows: the key's own, or «Passkey from <date>». */
export function passkeyDisplayName(
  keyName: string | null,
  addedAt: Date | string,
  locale?: string | null,
): string {
  if (keyName) return keyName;
  const emailLocale = resolveEmailLocale(locale);
  const date = formatDate(addedAt, emailHtmlLang(emailLocale)) ?? "";
  return messages[emailLocale].unnamed(date);
}

export function passkeyAddedSubject(name: string, locale?: string | null) {
  return subjects[resolveEmailLocale(locale)](name);
}

const PasskeyAddedEmail = ({
  keyName,
  alertLink,
  days,
  locale,
  email,
  instance,
  requestedAt,
  device,
}: PasskeyAddedEmailProps) => {
  const emailLocale = resolveEmailLocale(locale);
  const copy = messages[emailLocale];
  const name = passkeyDisplayName(keyName, requestedAt ?? new Date(), locale);

  return (
    <EmailShell
      title={copy.title}
      preview={copy.preview(name)}
      lang={emailHtmlLang(emailLocale)}
    >
      <EmailIntro title={copy.title} subtitle={copy.subtitle(name)} />
      <EmailButton href={alertLink} icon="key-round-light">
        {copy.cta}
      </EmailButton>
      <FallbackLink label={copy.fallback} href={alertLink} />
      <RequestDetails
        locale={emailLocale}
        email={email}
        instance={instance}
        requestedAt={requestedAt}
        device={device}
      />
      <EmailNote title={copy.noteTitle}>{copy.note(days)}</EmailNote>
      <EmailFooter
        title={copy.footer}
        reason={
          email ? passkeyAddedReason[emailLocale](email, instance) : undefined
        }
        links={footerLinks(emailLocale)}
      />
    </EmailShell>
  );
};

PasskeyAddedEmail.PreviewProps = {
  keyName: "MacBook",
  alertLink: "https://cloud.kaneo.app/account/passkey-alert#t=example",
  days: 7,
  locale: "en-US",
  email: "maya@example.com",
  instance: "cloud.kaneo.app",
  requestedAt: "2026-11-18T14:12:00.000Z",
  device: { browser: "Safari", os: "macOS" },
} as PasskeyAddedEmailProps;

export default PasskeyAddedEmail;
