import React from "react";
import { EmailFooter } from "../components/email-footer";
import { EmailIntro } from "../components/email-intro";
import { EmailNote } from "../components/email-note";
import { EmailShell } from "../components/email-shell";
import { footerLinks } from "../components/footer-links";
import { OtpCode } from "../components/otp-code";
import {
  type RequestContext,
  RequestDetails,
} from "../components/request-details";
import { reauthReason } from "../components/security-reasons";
import { emailHtmlLang, resolveEmailLocale } from "./resolve-locale";

void React;

/** TB-31 R-5: the code that confirms a sensitive action in a signed-in session. */
export type ReauthCodeEmailProps = RequestContext & {
  code: string;
  /** Lifetime of the code in minutes; the server passes its own TTL. */
  minutes: number;
  locale?: string | null;
};

const messages = {
  en: {
    preview: (m: number) =>
      `Enter it in Kaneo to confirm it's you. It expires in ${m} minutes.`,
    title: "Confirm it's you",
    subtitle:
      "Enter this code in Kaneo to continue with a protected action. It works once.",
    codeLabel: "Confirmation code",
    code: "is your Kaneo confirmation code.",
    expiry: (m: number) => `This code expires in ${m} minutes.`,
    ignoreTitle: "Didn't ask for this?",
    ignore:
      "Someone who is signed in to your account asked for it. If it wasn't you, sign out of your other sessions and change your password.",
    footer: "Kaneo security email",
  },
  de: {
    preview: (m: number) =>
      `Gib ihn in Kaneo ein, um zu bestätigen, dass du es bist. Er läuft in ${m} Minuten ab.`,
    title: "Bestätige, dass du es bist",
    subtitle:
      "Gib diesen Code in Kaneo ein, um mit einer geschützten Aktion fortzufahren. Er funktioniert nur einmal.",
    codeLabel: "Bestätigungscode",
    code: "ist dein Kaneo Bestätigungscode.",
    expiry: (m: number) => `Dieser Code läuft in ${m} Minuten ab.`,
    ignoreTitle: "Nicht angefordert?",
    ignore:
      "Jemand, der in deinem Konto angemeldet ist, hat ihn angefordert. Warst du es nicht, melde deine anderen Sitzungen ab und ändere dein Passwort.",
    footer: "Kaneo Sicherheits-E-Mail",
  },
  vi: {
    preview: (m: number) =>
      `Nhập mã này trong Kaneo để xác nhận đó là bạn. Mã hết hạn sau ${m} phút.`,
    title: "Xác nhận đó là bạn",
    subtitle:
      "Nhập mã này trong Kaneo để tiếp tục một thao tác được bảo vệ. Mã chỉ dùng được một lần.",
    codeLabel: "Mã xác nhận",
    code: "là mã xác nhận Kaneo của bạn.",
    expiry: (m: number) => `Mã này sẽ hết hạn sau ${m} phút.`,
    ignoreTitle: "Bạn không yêu cầu mã này?",
    ignore:
      "Một người đang đăng nhập vào tài khoản của bạn đã yêu cầu mã. Nếu không phải bạn, hãy đăng xuất các phiên khác và đổi mật khẩu.",
    footer: "Email bảo mật Kaneo",
  },
  ja: {
    preview: (m: number) =>
      `Kaneo で入力して本人確認をしてください。有効期限は${m}分です。`,
    title: "本人確認",
    subtitle:
      "保護された操作を続けるには、Kaneo でこのコードを入力してください。コードは1回のみ有効です。",
    codeLabel: "確認コード",
    code: "はあなたの Kaneo 確認コードです。",
    expiry: (m: number) => `このコードの有効期限は${m}分です。`,
    ignoreTitle: "リクエストしていませんか？",
    ignore:
      "あなたのアカウントにサインインしている人がリクエストしました。心当たりがない場合は、他のセッションからサインアウトし、パスワードを変更してください。",
    footer: "Kaneo セキュリティメール",
  },
  "zh-tw": {
    preview: (m: number) =>
      `在 Kaneo 中輸入以確認是你本人。驗證碼將在 ${m} 分鐘後失效。`,
    title: "確認是你本人",
    subtitle: "在 Kaneo 中輸入此驗證碼以繼續受保護的操作。驗證碼只能使用一次。",
    codeLabel: "確認碼",
    code: "是你的 Kaneo 確認碼。",
    expiry: (m: number) => `此驗證碼將在 ${m} 分鐘後失效。`,
    ignoreTitle: "不是你要求的？",
    ignore:
      "有人以你的帳號登入並要求了此驗證碼。如果不是你，請登出其他工作階段並變更密碼。",
    footer: "Kaneo 安全性通知",
  },
} as const;

const subjects = {
  en: (code: string) => `${code} is your Kaneo confirmation code`,
  de: (code: string) => `${code} ist dein Kaneo-Bestätigungscode`,
  vi: (code: string) => `${code} là mã xác nhận Kaneo của bạn`,
  ja: (code: string) => `Kaneo の確認コード: ${code}`,
  "zh-tw": (code: string) => `你的 Kaneo 確認碼：${code}`,
} as const;

export function reauthCodeSubject(code: string, locale?: string | null) {
  return subjects[resolveEmailLocale(locale)](code);
}

const ReauthCodeEmail = ({
  code,
  minutes,
  locale,
  email,
  instance,
  requestedAt,
  device,
}: ReauthCodeEmailProps) => {
  const emailLocale = resolveEmailLocale(locale);
  const copy = messages[emailLocale];

  return (
    <EmailShell
      title={copy.title}
      preview={copy.preview(minutes)}
      lang={emailHtmlLang(emailLocale)}
    >
      <EmailIntro title={copy.title} subtitle={copy.subtitle} />
      <OtpCode
        code={code}
        label={copy.codeLabel}
        hint={`${code} ${copy.code} ${copy.expiry(minutes)}`}
      />
      <RequestDetails
        locale={emailLocale}
        email={email}
        instance={instance}
        requestedAt={requestedAt}
        device={device}
      />
      <EmailNote title={copy.ignoreTitle}>{copy.ignore}</EmailNote>
      <EmailFooter
        title={copy.footer}
        reason={email ? reauthReason[emailLocale](email, instance) : undefined}
        links={footerLinks(emailLocale)}
      />
    </EmailShell>
  );
};

ReauthCodeEmail.PreviewProps = {
  code: "482913",
  minutes: 10,
  locale: "en-US",
  email: "maya@example.com",
  instance: "cloud.kaneo.app",
  requestedAt: "2026-10-11T14:12:00.000Z",
  device: { browser: "Safari", os: "iPhone" },
} as ReauthCodeEmailProps;

export default ReauthCodeEmail;
