import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFreshSession } from "@/components/reauth/use-fresh-session";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { isDeleteConfirmationValid } from "@/components/settings/profile/is-delete-confirmation-valid";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import useDeleteAccount from "@/hooks/mutations/use-delete-account";
import { isReauthFlowError } from "@/lib/reauth/reauth-errors";
import { toast } from "@/lib/toast";

type DeleteAccountSectionProps = {
  email: string | undefined;
};

export function DeleteAccountSection({ email }: DeleteAccountSectionProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const { mutateAsync: deleteAccount, isPending } = useDeleteAccount();
  const freshSession = useFreshSession();
  const canConfirm = isDeleteConfirmationValid(confirmation, email);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setConfirmation("");
  };

  const handleDelete = async () => {
    if (!canConfirm) return;

    try {
      await freshSession.run(() => deleteAccount());
      setOpen(false);
      queryClient.clear();
      toast.success(t("settings:informationPage.deleteAccount.success"), {
        icon: Trash2Icon,
      });
      navigate({ to: "/auth/sign-in" });
    } catch (error) {
      // TB-31 R-5: the fresh sign-in window replaced «sign in again».
      if (isReauthFlowError(error)) return;
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:informationPage.deleteAccount.error"),
      );
    }
  };

  return (
    <SettingsSection
      title={t("settings:informationPage.deleteAccount.sectionTitle")}
    >
      <SettingsCard tone="danger">
        <SettingsRow
          stack
          title={t("settings:informationPage.deleteAccount.title")}
          description={t("settings:informationPage.deleteAccount.description")}
        >
          <Button
            type="button"
            variant="destructive-outline"
            size="sm"
            onClick={() => setOpen(true)}
          >
            {t("settings:informationPage.deleteAccount.title")}
          </Button>
        </SettingsRow>
      </SettingsCard>
      <ConfirmDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t("settings:informationPage.deleteAccount.modalTitle")}
        description={t(
          "settings:informationPage.deleteAccount.modalDescription",
          {
            email: email ?? "",
          },
        )}
        confirmLabel={t("settings:informationPage.deleteAccount.confirm")}
        pendingLabel={t("common:actions.deleting")}
        pending={isPending}
        confirmDisabled={!canConfirm}
        onConfirm={handleDelete}
      >
        <div className="space-y-2">
          <Label htmlFor={inputId}>
            {t("settings:informationPage.deleteAccount.confirmLabel", {
              email: email ?? "",
            })}
          </Label>
          <Input
            id={inputId}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={isPending}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={email ?? ""}
          />
        </div>
        {freshSession.dialog}
      </ConfirmDialog>
    </SettingsSection>
  );
}
