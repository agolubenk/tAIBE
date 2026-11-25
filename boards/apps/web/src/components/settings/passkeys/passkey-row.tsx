import type { TFunction } from "i18next";
import { KeyRoundIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { RowActionsMenu } from "@/components/settings/row-actions-menu";
import { SettingsRow } from "@/components/settings/settings-row";
import { formatDateMedium } from "@/lib/format";
import type { PasskeyItem } from "@/lib/passkey/passkey-api";

/** A key without a name reads as in the «A passkey was added» email. */
export function passkeyName(key: PasskeyItem, t: TFunction): string {
  return (
    key.name ??
    t("settings:passkeys.unnamed", { date: formatDateMedium(key.createdAt) })
  );
}

type Props = {
  passkey: PasskeyItem;
  onRename: (passkey: PasskeyItem) => void;
  onDelete: (passkey: PasskeyItem) => void;
};

export function PasskeyRow({ passkey, onRename, onDelete }: Props) {
  const { t } = useTranslation();
  const name = passkeyName(passkey, t);
  const type = t(
    passkey.deviceType === "multiDevice"
      ? "settings:passkeys.multiDevice"
      : "settings:passkeys.singleDevice",
  );
  const added = t("settings:passkeys.added", {
    date: formatDateMedium(passkey.createdAt),
  });

  return (
    <SettingsRow
      icon={<KeyRoundIcon />}
      title={name}
      description={
        <span className="truncate">
          {type} · {added}
        </span>
      }
    >
      <RowActionsMenu
        label={t("settings:passkeys.actions", { name })}
        actions={[
          {
            id: "rename",
            label: t("settings:passkeys.rename"),
            icon: PencilIcon,
            onSelect: () => onRename(passkey),
          },
          {
            id: "delete",
            label: t("settings:passkeys.delete"),
            icon: Trash2Icon,
            destructive: true,
            onSelect: () => onDelete(passkey),
          },
        ]}
      />
    </SettingsRow>
  );
}
