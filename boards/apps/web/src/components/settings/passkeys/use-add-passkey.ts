import { REAUTH_ERRORS } from "@kaneo/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFreshSession } from "@/components/reauth/use-fresh-session";
import { PASSKEYS_QUERY_KEY } from "@/hooks/queries/passkey/use-passkeys";
import { addPasskey } from "@/lib/passkey/passkey-client";
import { passkeyMessageKey } from "@/lib/passkey/passkey-message";
import { SessionNotFreshError } from "@/lib/reauth/reauth-errors";
import { toast } from "@/lib/toast";

// "confirmed": the window confirmed the person; the key needs a new press.
export type AddPasskeyStage = "idle" | "busy" | "confirmed";

/**
 * TB-31 R-6, «Добавить ключ». Adding is guarded by R-5. After the window the
 * ceremony does not start by itself: Safari and iOS create a key only in
 * answer to a press, so the button turns into «Продолжить».
 */
export function useAddPasskey() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fresh = useFreshSession();
  const [stage, setStage] = useState<AddPasskeyStage>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const add = async () => {
    if (stage === "busy") return;
    const afterWindow = stage === "confirmed";
    setStage("busy");
    setMessage(null);
    const reply = await addPasskey();
    if (reply.ok) {
      setStage("idle");
      toast.success(t("settings:passkeys.toastAdded"));
      await queryClient.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY });
      return;
    }
    if (reply.code === REAUTH_ERRORS.sessionNotFresh && !afterWindow) {
      const confirmed = await fresh.confirm(
        new SessionNotFreshError({
          code: REAUTH_ERRORS.sessionNotFresh,
          message: "",
          methods: reply.methods ?? [],
          impersonated: reply.impersonated ? true : undefined,
        }),
      );
      setStage(confirmed ? "confirmed" : "idle");
      return;
    }
    setStage("idle");
    if (reply.cancelled) return;
    setMessage(
      reply.code === REAUTH_ERRORS.sessionNotFresh
        ? t("auth:reauth.errors.stillNotFresh")
        : t(passkeyMessageKey(reply)),
    );
  };

  return { stage, message, add, dialog: fresh.dialog };
}
