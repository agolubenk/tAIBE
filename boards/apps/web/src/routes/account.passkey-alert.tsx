import { createFileRoute } from "@tanstack/react-router";
import { PasskeyAlertPage } from "@/components/account/passkey-alert/passkey-alert-page";

// TB-31 R-6: «Это не я» from the «A passkey was added» email
// (PASSKEY_ALERT_PAGE). No session needed. More specific than /account/$.
export const Route = createFileRoute("/account/passkey-alert")({
  component: PasskeyAlertPage,
});
