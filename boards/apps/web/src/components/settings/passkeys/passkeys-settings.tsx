import { PASSKEY_MAX_PER_USER } from "@kaneo/permissions";
import { FingerprintIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsEmpty } from "@/components/settings/settings-empty";
import { SettingsRowsSkeleton } from "@/components/settings/settings-rows-skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { usePasskeys } from "@/hooks/queries/passkey/use-passkeys";
import type { PasskeyItem } from "@/lib/passkey/passkey-api";
import { supportsPasskeys } from "@/lib/passkey/passkey-client";
import { DeletePasskeyDialog } from "./delete-passkey-dialog";
import { PasskeyRow, passkeyName } from "./passkey-row";
import { RenamePasskeyDialog } from "./rename-passkey-dialog";
import { useAddPasskey } from "./use-add-passkey";

/**
 * «Ключи входа» on the Security tab (TB-31 R-6). Hidden in a browser without
 * WebAuthn. The password stays while there are keys: a key works only on
 * the site's main name.
 */
export function PasskeysSettings() {
  const [supported] = useState(supportsPasskeys);
  return supported ? <PasskeysSection /> : null;
}

function PasskeysSection() {
  const { t } = useTranslation();
  const statusId = useId();
  const keys = usePasskeys();
  const adding = useAddPasskey();
  const [renaming, setRenaming] = useState<PasskeyItem | null>(null);
  const [deleting, setDeleting] = useState<PasskeyItem | null>(null);
  const list = keys.data ?? [];
  const full = list.length >= PASSKEY_MAX_PER_USER;

  // The reason a disabled button cannot be pressed is written out (spec).
  const status = full
    ? t("settings:passkeys.limit", { max: PASSKEY_MAX_PER_USER })
    : adding.stage === "confirmed"
      ? t("settings:passkeys.continueHint")
      : adding.message;

  const addButton = (
    <Button
      type="button"
      variant={adding.stage === "confirmed" ? "default" : "outline"}
      size="sm"
      loading={adding.stage === "busy"}
      disabled={full || keys.isPending}
      aria-describedby={statusId}
      onClick={() => void adding.add()}
    >
      <PlusIcon aria-hidden="true" />
      {t(
        adding.stage === "confirmed"
          ? "settings:passkeys.continue"
          : "settings:passkeys.add",
      )}
    </Button>
  );

  const renderKeys = () => {
    if (keys.isPending)
      return <SettingsRowsSkeleton rows={1} withDescription />;
    if (keys.isError) {
      return (
        <p
          role="alert"
          className="px-4 py-3.5 text-destructive-foreground text-sm"
        >
          {t("settings:passkeys.loadError")}
        </p>
      );
    }
    if (list.length === 0) {
      return (
        <SettingsEmpty
          icon={<FingerprintIcon />}
          title={t("settings:passkeys.emptyTitle")}
          description={t("settings:passkeys.emptyDescription")}
        />
      );
    }
    return list.map((key) => (
      <PasskeyRow
        key={key.id}
        passkey={key}
        onRename={setRenaming}
        onDelete={setDeleting}
      />
    ));
  };

  return (
    <SettingsSection
      title={t("settings:passkeys.title")}
      description={t("settings:passkeys.description")}
      action={addButton}
    >
      <SettingsCard>{renderKeys()}</SettingsCard>
      <p
        id={statusId}
        aria-live="polite"
        className={
          adding.message && !full
            ? "text-destructive-foreground text-sm empty:hidden"
            : "text-muted-foreground text-sm empty:hidden"
        }
      >
        {status}
      </p>
      {adding.dialog}
      <RenamePasskeyDialog
        passkey={renaming}
        shownName={renaming ? passkeyName(renaming, t) : ""}
        onClose={() => setRenaming(null)}
      />
      <DeletePasskeyDialog
        passkey={deleting}
        shownName={deleting ? passkeyName(deleting, t) : ""}
        onClose={() => setDeleting(null)}
      />
    </SettingsSection>
  );
}
