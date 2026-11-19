import {
  REAUTH_CODE_LENGTH,
  REAUTH_CODE_TTL_SECONDS,
} from "@kaneo/permissions";
import { type FormEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { postReauth, type ReauthReply } from "@/lib/reauth/reauth-api";
import { type ReauthMessage, reauthMessage } from "@/lib/reauth/reauth-message";

type StepProps = {
  // Every reply goes to the window: a failed one may carry new methods.
  onReply: (reply: ReauthReply) => void;
};

function useTry(onReply: StepProps["onReply"]) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ReauthMessage | null>(null);
  // `confirms`: only a password or code check confirms; a sent code does not.
  const run = async (send: () => Promise<ReauthReply>, confirms: boolean) => {
    setBusy(true);
    setMessage(null);
    const reply = await send();
    setBusy(false);
    if (!reply.ok) setMessage(reauthMessage(reply));
    if (!reply.ok || confirms) onReply(reply);
    return reply;
  };
  return { busy, message, setMessage, run };
}

// React bubbles a portal's submit up the React tree: the form that opened the
// window must not submit again.
function stopSubmit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  event.stopPropagation();
}

// The error is bound to its field and read out at once (spec R-5, AC-15).
function StepError({
  id,
  message,
}: {
  id: string;
  message: ReauthMessage | null;
}) {
  const { t } = useTranslation();
  return (
    <p
      id={id}
      aria-live="assertive"
      className="min-h-5 text-destructive-foreground text-sm"
    >
      {message ? t(message.key, message.values) : null}
    </p>
  );
}

export function PasswordStep({ onReply }: StepProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const [password, setPassword] = useState("");
  const { busy, message, run } = useTry(onReply);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    stopSubmit(event);
    if (!password || busy) return;
    const reply = await run(() => postReauth("password", { password }), true);
    if (!reply.ok) setPassword("");
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <Field>
        <FieldLabel>{t("auth:reauth.password.label")}</FieldLabel>
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          disabled={busy}
          aria-invalid={message ? true : undefined}
          aria-describedby={errorId}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <StepError id={errorId} message={message} />
      <Button type="submit" loading={busy} disabled={!password}>
        {t("auth:reauth.password.submit")}
      </Button>
    </form>
  );
}

export function CodeStep({ onReply }: StepProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const { busy, message, run } = useTry(onReply);

  // The window sends nothing until the person picks a method (AC-17).
  const send = async () => {
    const reply = await run(() => postReauth("sendCode"), false);
    if (reply.ok) {
      setSent(true);
      setCode("");
    }
  };

  const verify = async (event: FormEvent<HTMLFormElement>) => {
    stopSubmit(event);
    if (code.length !== REAUTH_CODE_LENGTH || busy) return;
    const reply = await run(() => postReauth("verifyCode", { code }), true);
    if (!reply.ok && reauthMessage(reply).codeGone) setCode("");
  };

  if (!sent) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-sm">
          {t("auth:reauth.code.explain", { length: REAUTH_CODE_LENGTH })}
        </p>
        <StepError id={errorId} message={message} />
        <Button type="button" loading={busy} onClick={() => void send()}>
          {t("auth:reauth.code.send")}
        </Button>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={verify}>
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {t("auth:reauth.code.sent", {
          minutes: REAUTH_CODE_TTL_SECONDS / 60,
        })}
      </p>
      <Field>
        <FieldLabel>{t("auth:reauth.code.label")}</FieldLabel>
        <Input
          name="one-time-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={REAUTH_CODE_LENGTH}
          autoFocus
          value={code}
          disabled={busy}
          aria-invalid={message ? true : undefined}
          aria-describedby={errorId}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
        />
      </Field>
      <StepError id={errorId} message={message} />
      <Button
        type="submit"
        loading={busy}
        disabled={code.length !== REAUTH_CODE_LENGTH}
      >
        {t("auth:reauth.code.submit")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void send()}
      >
        {t("auth:reauth.code.resend")}
      </Button>
    </form>
  );
}
