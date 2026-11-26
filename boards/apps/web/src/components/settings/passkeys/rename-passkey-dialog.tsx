import { PASSKEY_NAME_MAX } from "@kaneo/permissions";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PASSKEYS_QUERY_KEY } from "@/hooks/queries/passkey/use-passkeys";
import { type PasskeyItem, renamePasskey } from "@/lib/passkey/passkey-api";
import { toast } from "@/lib/toast";

type Props = {
  passkey: PasskeyItem | null;
  // The name the row shows, also for a key without a name.
  shownName: string;
  onClose: () => void;
};

export function RenamePasskeyDialog({ passkey, shownName, onClose }: Props) {
  return (
    <Dialog
      open={passkey !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        {passkey ? (
          <RenameForm
            key={passkey.id}
            passkey={passkey}
            shownName={shownName}
            onClose={onClose}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function RenameForm({
  passkey,
  shownName,
  onClose,
}: Props & { passkey: PasskeyItem }) {
  const { t } = useTranslation();
  const errorId = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(passkey.name ?? shownName);
  const [failed, setFailed] = useState(false);
  const trimmed = name.trim();
  const rename = useMutation({
    mutationFn: () => renamePasskey(passkey.id, trimmed),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY });
      toast.success(t("settings:passkeys.toastRenamed"));
      onClose();
    },
    onError: () => setFailed(true),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmed || rename.isPending) return;
    setFailed(false);
    rename.mutate();
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{t("settings:passkeys.renameTitle")}</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <Field>
          <FieldLabel>{t("settings:passkeys.nameLabel")}</FieldLabel>
          <Input
            name="passkey-name"
            autoFocus
            maxLength={PASSKEY_NAME_MAX}
            value={name}
            disabled={rename.isPending}
            aria-invalid={failed ? true : undefined}
            aria-describedby={errorId}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <p
          id={errorId}
          aria-live="assertive"
          className="min-h-5 pt-1 text-destructive-foreground text-sm"
        >
          {failed ? t("settings:passkeys.renameError") : null}
        </p>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          {t("common:actions.cancel")}
        </DialogClose>
        <Button type="submit" loading={rename.isPending} disabled={!trimmed}>
          {t("settings:passkeys.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
