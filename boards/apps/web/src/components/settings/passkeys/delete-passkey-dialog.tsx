import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFreshSession } from "@/components/reauth/use-fresh-session";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { PASSKEYS_QUERY_KEY } from "@/hooks/queries/passkey/use-passkeys";
import { type PasskeyItem, removePasskey } from "@/lib/passkey/passkey-api";
import { isReauthFlowError } from "@/lib/reauth/reauth-errors";
import { toast } from "@/lib/toast";

type Props = {
  passkey: PasskeyItem | null;
  shownName: string;
  onClose: () => void;
};

/** Removing a key is guarded by R-5: the window opens inside this one. */
export function DeletePasskeyDialog({ passkey, shownName, onClose }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fresh = useFreshSession();
  const remove = useMutation({
    mutationFn: (id: string) => fresh.run(() => removePasskey(id)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY });
      toast.success(t("settings:passkeys.toastDeleted"), { icon: Trash2Icon });
      onClose();
    },
    onError: (error) => {
      // The window answers these; a cancel keeps this dialog open.
      if (isReauthFlowError(error)) return;
      toast.error(t("settings:passkeys.deleteError"));
    },
  });

  return (
    <ConfirmDialog
      open={passkey !== null}
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
      title={t("settings:passkeys.deleteTitle", { name: shownName })}
      description={t("settings:passkeys.deleteDescription")}
      confirmLabel={t("settings:passkeys.delete")}
      pendingLabel={t("common:actions.deleting")}
      pending={remove.isPending}
      onConfirm={() => {
        if (passkey) remove.mutate(passkey.id);
      }}
      // The body holds only the R-5 window, which renders in a portal.
      bodyClassName="p-0"
    >
      {fresh.dialog}
    </ConfirmDialog>
  );
}
