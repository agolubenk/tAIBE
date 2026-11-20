import {
  PASSKEY_ALERT_TTL_DAYS,
  PASSKEY_ERRORS,
  type PasskeyAlertInspect,
} from "@kaneo/permissions";
import { Link } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthFormSkeleton } from "@/components/auth/auth-form-skeleton";
import { AuthPage } from "@/components/auth/auth-page";
import PageTitle from "@/components/page-title";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { formatDateMedium, formatDateTime } from "@/lib/format";
import {
  confirmPasskeyAlert,
  inspectPasskeyAlert,
  type PasskeyAlertReply,
} from "@/lib/passkey/passkey-api";

// TB-31 R-6, «Это не я» from the «A passkey was added» email. No session: the
// link is the proof. The token comes in `#t=` (a fragment is not sent to the
// server and not logged) and leaves the address bar once read.

type State =
  | { step: "loading" }
  | { step: "invalid" }
  // 429 or no answer: the token is kept in memory, the person may retry.
  | { step: "retry"; error: string }
  | { step: "ready"; key: PasskeyAlertInspect; error?: string; busy?: boolean }
  | { step: "done" };

export function readAlertToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("t");
  return token?.trim() || null;
}

function failureText(
  reply: Extract<PasskeyAlertReply<unknown>, { ok: false }>,
) {
  if (reply.status === 429) return "auth:passkeyAlert.errors.rateLimited";
  if (reply.status === 0) return "auth:passkeyAlert.errors.offline";
  return "auth:passkeyAlert.errors.failed";
}

function isInvalid(reply: Extract<PasskeyAlertReply<unknown>, { ok: false }>) {
  return reply.code === PASSKEY_ERRORS.alertInvalid;
}

export function PasskeyAlertPage() {
  const { t } = useTranslation();
  // Read before the effect below clears the fragment.
  const [token] = useState(() => readAlertToken(window.location.hash));
  const [state, setState] = useState<State>(
    token ? { step: "loading" } : { step: "invalid" },
  );

  useEffect(() => {
    if (!window.location.hash) return;
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", pathname + search);
  }, []);

  const inspect = useCallback(async () => {
    if (!token) return;
    setState({ step: "loading" });
    const reply = await inspectPasskeyAlert(token);
    if (reply.ok) setState({ step: "ready", key: reply.data });
    else if (isInvalid(reply)) setState({ step: "invalid" });
    else setState({ step: "retry", error: failureText(reply) });
  }, [token]);

  useEffect(() => {
    void inspect();
  }, [inspect]);

  const confirm = async (key: PasskeyAlertInspect) => {
    if (!token) return;
    setState({ step: "ready", key, busy: true });
    const reply = await confirmPasskeyAlert(token);
    if (reply.ok) {
      // Every session of the person is gone, this browser's too.
      authClient.$store.notify("$sessionSignal");
      setState({ step: "done" });
    } else if (isInvalid(reply)) {
      setState({ step: "invalid" });
    } else {
      setState({ step: "ready", key, error: failureText(reply) });
    }
  };

  const title = t("auth:passkeyAlert.pageTitle");

  if (state.step === "loading") {
    return (
      <>
        <PageTitle title={title} />
        <AuthPage title={t("auth:passkeyAlert.title")}>
          <AuthFormSkeleton />
        </AuthPage>
      </>
    );
  }

  if (state.step === "invalid") {
    return (
      <>
        <PageTitle title={title} />
        <AuthPage
          title={t("auth:passkeyAlert.invalidTitle")}
          description={t("auth:passkeyAlert.invalidDescription", {
            days: PASSKEY_ALERT_TTL_DAYS,
          })}
        >
          <Button render={<Link to="/auth/sign-in" />} variant="outline">
            {t("auth:passkeyAlert.toSignIn")}
          </Button>
        </AuthPage>
      </>
    );
  }

  if (state.step === "retry") {
    return (
      <>
        <PageTitle title={title} />
        <AuthPage title={t("auth:passkeyAlert.title")}>
          <p role="alert" className="pb-4 text-destructive-foreground text-sm">
            {t(state.error)}
          </p>
          <Button type="button" onClick={() => void inspect()}>
            {t("auth:passkeyAlert.retry")}
          </Button>
        </AuthPage>
      </>
    );
  }

  if (state.step === "done") {
    return (
      <>
        <PageTitle title={title} />
        <AuthPage
          title={t("auth:passkeyAlert.doneTitle")}
          description={t("auth:passkeyAlert.doneDescription")}
        >
          <Button render={<Link to="/auth/forgot-password" />}>
            {t("auth:passkeyAlert.resetPassword")}
          </Button>
        </AuthPage>
      </>
    );
  }

  const { key, error, busy = false } = state;
  const name =
    key.keyName ??
    t("settings:passkeys.unnamed", { date: formatDateMedium(key.addedAt) });

  return (
    <>
      <PageTitle title={title} />
      <AuthPage
        title={t("auth:passkeyAlert.title")}
        description={t(
          key.keyExists
            ? "auth:passkeyAlert.description"
            : "auth:passkeyAlert.descriptionRemoved",
          { name, date: formatDateTime(key.addedAt) },
        )}
        notice={
          <Alert variant="warning">
            <CircleAlert />
            <AlertDescription>{t("auth:passkeyAlert.effect")}</AlertDescription>
          </Alert>
        }
      >
        <div className="flex flex-col gap-3">
          <p
            aria-live="assertive"
            className="text-destructive-foreground text-sm empty:hidden"
          >
            {error ? t(error) : null}
          </p>
          <Button
            type="button"
            variant="destructive"
            loading={busy}
            onClick={() => void confirm(key)}
          >
            {t(
              key.keyExists
                ? "auth:passkeyAlert.confirm"
                : "auth:passkeyAlert.confirmRemoved",
            )}
          </Button>
          <Button render={<Link to="/" />} variant="ghost" disabled={busy}>
            {t("auth:passkeyAlert.itWasMe")}
          </Button>
        </div>
      </AuthPage>
    </>
  );
}
