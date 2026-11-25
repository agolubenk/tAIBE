export { OTP_EXPIRY_SECONDS } from "./otp-expiry";
export {
  sendMagicLinkEmail,
  sendNotificationEmail,
  sendOtpEmail,
  sendPasskeyAddedEmail,
  sendPasswordResetEmail,
  sendReauthCodeEmail,
  sendTrialReminderEmail,
  sendWorkspaceInvitationEmail,
} from "./send-email";
export { isSmtpConfigured } from "./smtp-config";
export type { EmailResult } from "./send-email";
export {
  passkeyAddedSubject,
  passkeyDisplayName,
} from "./templates/passkey-added";
export { reauthCodeSubject } from "./templates/reauth-code";
export type { BoardColumnIcon } from "./components/board-column";
export type {
  TaskCardDueStatus,
  TaskCardPriority,
} from "./components/task-card";
export type { NotificationEmailTask } from "./templates/notification";
