import { KeyRoundIcon } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  signInWithPasskey,
  supportsPasskeys,
} from "@/lib/passkey/passkey-client";
import {
  type PasskeyMessageKey,
  passkeyMessageKey,
} from "@/lib/passkey/passkey-message";

type Props = {
  disabled?: boolean;
  onSuccess: () => void;
};

/**
 * «Войти с ключом» (TB-31 R-6; Q-904: a button, no autofill). The password
 * stays. Hidden in a browser without WebAuthn.
 */
export function PasskeySignInButton({ disabled = false, onSuccess }: Props) {
  const { t } = useTranslation();
  const errorId = useId();
  const [supported] = useState(supportsPasskeys);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<PasskeyMessageKey | null>(null);

  if (!supported) return null;

  const signIn = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const reply = await signInWithPasskey();
    setBusy(false);
    if (reply.ok) {
      onSuccess();
      return;
    }
    if (!reply.cancelled) setMessage(passkeyMessageKey(reply));
  };

  return (
    <div className="flex flex-col gap-1.5 pt-3">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        loading={busy}
        disabled={disabled}
        aria-describedby={errorId}
        onClick={() => void signIn()}
      >
        <KeyRoundIcon aria-hidden="true" />
        {t("auth:passkey.signIn")}
      </Button>
      <p
        id={errorId}
        aria-live="assertive"
        className="text-destructive-foreground text-sm empty:hidden"
      >
        {message ? t(message) : null}
      </p>
    </div>
  );
}
