import type { EmailResult } from "../../../packages/email/src/send-email";

export { OTP_EXPIRY_SECONDS } from "../../../packages/email/src/otp-expiry";

export async function sendMagicLinkEmail(
  _to: string,
  _subject: string,
  _data: unknown,
): Promise<void> {
  return undefined;
}

export async function sendOtpEmail(
  _to: string,
  _subject: string,
  _data: unknown,
): Promise<void> {
  return undefined;
}

export async function sendWorkspaceInvitationEmail(
  _to: string,
  _subject: string,
  _data: unknown,
): Promise<EmailResult> {
  return { success: true };
}

export function isSmtpConfigured(): boolean {
  return false;
}

export async function sendPasswordResetEmail(
  _to: string,
  _subject: string,
  _data: unknown,
): Promise<void> {
  return undefined;
}

export async function sendReauthCodeEmail(
  _to: string,
  _subject: string,
  _data: unknown,
): Promise<EmailResult> {
  return { success: true };
}

export function reauthCodeSubject(code: string, _locale?: string | null) {
  return `${code} is your Kaneo confirmation code`;
}

// TB-31 R-6: the «A passkey was added» email (passkey/passkey-alert.ts).
export async function sendPasskeyAddedEmail(
  _to: string,
  _subject: string,
  _data: unknown,
): Promise<EmailResult> {
  return { success: true };
}

export function passkeyDisplayName(
  keyName: string | null,
  addedAt: Date | string,
  _locale?: string | null,
) {
  return keyName || `Passkey from ${new Date(addedAt).toISOString()}`;
}

export function passkeyAddedSubject(name: string, _locale?: string | null) {
  return `A passkey was added to your Kaneo account: ${name}`;
}
