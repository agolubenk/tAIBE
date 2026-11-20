import type { ReauthMethod } from "@kaneo/permissions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { supportsPasskeys } from "@/lib/passkey/passkey-client";
import type { ReauthReply } from "@/lib/reauth/reauth-api";
import { CodeStep, PasskeyStep, PasswordStep } from "./reauth-steps";

// The link that switches the window to another method.
const SWITCH_LABEL = {
  password: "auth:reauth.usePassword",
  passkey: "auth:reauth.usePasskey",
  emailCode: "auth:reauth.useCode",
} as const satisfies Record<ReauthMethod, string>;

// A browser without WebAuthn cannot use a key: the window does not offer it.
function usable(methods: ReauthMethod[]): ReauthMethod[] {
  return supportsPasskeys()
    ? methods
    : methods.filter((method) => method !== "passkey");
}

export type ReauthRequest = {
  // A new id per opening: the window starts clean each time.
  id: number;
  open: boolean;
  methods: ReauthMethod[];
  impersonated: boolean;
  // Focus goes back here on close (spec R-5): the button that ran the action.
  opener: HTMLElement | null;
};

type Props = {
  request: ReauthRequest | null;
  onDone: (confirmed: boolean) => void;
};

/**
 * «Подтвердите, что это вы» (TB-31 R-5). Rendered inside the dialog that ran
 * the action, so Base UI nests it there. It shows only the methods the server
 * sent and redraws from the methods of every failed reply.
 */
export function ReauthDialog({ request, onDone }: Props) {
  if (!request) return null;
  const opener = request.opener;
  return (
    <Dialog
      open={request.open}
      onOpenChange={(open) => {
        if (!open) onDone(false);
      }}
    >
      <DialogPopup
        className="sm:max-w-sm"
        finalFocus={() => (opener?.isConnected ? opener : true)}
      >
        <ReauthBody key={request.id} request={request} onDone={onDone} />
      </DialogPopup>
    </Dialog>
  );
}

function ReauthBody({
  request,
  onDone,
}: {
  request: ReauthRequest;
  onDone: Props["onDone"];
}) {
  const { t } = useTranslation();
  const [methods, setMethods] = useState(() => usable(request.methods));
  const [view, setView] = useState<ReauthMethod | undefined>(methods[0]);
  // From the 10th failed try in an hour the server drops "password".
  const [lockedOut, setLockedOut] = useState(false);

  const onReply = (reply: ReauthReply) => {
    if (reply.ok) {
      onDone(true);
      return;
    }
    if (!reply.methods) return;
    const next = usable(reply.methods);
    if (methods.includes("password") && !next.includes("password")) {
      setLockedOut(true);
    }
    setMethods(next);
    if (!view || !next.includes(view)) setView(next[0]);
  };

  const others = methods.filter((method) => method !== view);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("auth:reauth.title")}</DialogTitle>
        <DialogDescription>{t("auth:reauth.description")}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-3">
          {lockedOut ? (
            <p role="status" className="text-sm">
              {t("auth:reauth.lockedOut")}
            </p>
          ) : null}
          {view === "password" ? <PasswordStep onReply={onReply} /> : null}
          {view === "passkey" ? <PasskeyStep onReply={onReply} /> : null}
          {view === "emailCode" ? <CodeStep onReply={onReply} /> : null}
          {view === undefined ? (
            <p role="status" className="text-sm">
              {request.impersonated
                ? t("auth:reauth.impersonated")
                : t("auth:reauth.noMethod")}
            </p>
          ) : null}
          {others.map((method) => (
            <Button
              key={method}
              type="button"
              variant="link"
              size="sm"
              className="self-start px-0"
              onClick={() => setView(method)}
            >
              {t(SWITCH_LABEL[method])}
            </Button>
          ))}
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          {t("common:actions.cancel")}
        </DialogClose>
      </DialogFooter>
    </>
  );
}
