import { type FormEvent, useState } from "react";
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
import { useFreshSession } from "@/components/reauth/use-fresh-session";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import useUpdateAdminUser from "@/hooks/mutations/admin/use-update-admin-user";
import type { AdminUser } from "@/hooks/queries/admin/use-admin-users";
import { hasAgentRole } from "@/lib/instance-admin";
import { ReauthCancelledError } from "@/lib/reauth/reauth-errors";
import {
  buildUserUpdate,
  EMPTY_EDIT_USER_VALUES,
  getEditUserValues,
} from "./edit-user-values";

type EditUserDialogProps = {
  user: AdminUser | null;
  currentUserId: string | undefined;
  onClose: () => void;
};

export function EditUserDialog({
  user,
  currentUserId,
  onClose,
}: EditUserDialogProps) {
  const { t } = useTranslation();
  const [previousUser, setPreviousUser] = useState(user);
  const [editedUser, setEditedUser] = useState(user);
  const [values, setValues] = useState(() =>
    user ? getEditUserValues(user) : EMPTY_EDIT_USER_VALUES,
  );
  const { mutateAsync: updateUser, isPending } = useUpdateAdminUser();
  const freshSession = useFreshSession();

  if (user !== previousUser) {
    setPreviousUser(user);
    if (user) {
      setEditedUser(user);
      setValues(getEditUserValues(user));
    }
  }

  const isSelf = editedUser !== null && editedUser.id === currentUserId;
  // R-010: an agent's role follows its owner; the server refuses to change it.
  const isAgent = editedUser !== null && hasAgentRole(editedUser.role);
  const roleLabel = t(
    isAgent
      ? "settings:adminUsers.roles.agent"
      : values.role === "admin"
        ? "settings:adminUsers.roles.admin"
        : "settings:adminUsers.roles.user",
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editedUser) return;

    const update = buildUserUpdate(editedUser, values, currentUserId);
    if (!update) return;

    try {
      // TB-31 R-5: a new email needs a fresh sign-in; name and role do not.
      await freshSession.run(() => updateUser(update));
      onClose();
    } catch (error) {
      // Cancelled window: the email field gets its saved value back (spec R-5).
      if (error instanceof ReauthCancelledError) {
        const saved = getEditUserValues(editedUser).email;
        setValues((current) => ({ ...current, email: saved }));
      }
    }
  };

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open && !isPending) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form className="contents" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("settings:adminUsers.edit.title")}</DialogTitle>
            <DialogDescription>
              {t("settings:adminUsers.edit.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <Field>
                <FieldLabel htmlFor="admin-user-name">
                  {t("settings:adminUsers.edit.name")}
                </FieldLabel>
                <Input
                  id="admin-user-name"
                  name="name"
                  type="text"
                  required
                  value={values.name}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="admin-user-email">
                  {t("settings:adminUsers.edit.email")}
                </FieldLabel>
                <Input
                  id="admin-user-email"
                  name="email"
                  type="email"
                  required
                  value={values.email}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="admin-user-role">
                  {t("settings:adminUsers.edit.role")}
                </FieldLabel>
                <Select
                  items={{
                    user: t("settings:adminUsers.roles.user"),
                    admin: t("settings:adminUsers.roles.admin"),
                  }}
                  value={values.role}
                  disabled={isSelf || isAgent}
                  onValueChange={(value) => {
                    if (value === "admin" || value === "user") {
                      setValues((current) => ({ ...current, role: value }));
                    }
                  }}
                >
                  <SelectTrigger id="admin-user-role">
                    <SelectValue>{roleLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="user">
                      {t("settings:adminUsers.roles.user")}
                    </SelectItem>
                    <SelectItem value="admin">
                      {t("settings:adminUsers.roles.admin")}
                    </SelectItem>
                  </SelectPopup>
                </Select>
                {isSelf ? (
                  <p className="text-xs text-muted-foreground">
                    {t("settings:adminUsers.edit.selfRoleHint")}
                  </p>
                ) : isAgent ? (
                  <p className="text-xs text-muted-foreground">
                    {t("settings:adminUsers.edit.agentRoleHint")}
                  </p>
                ) : null}
              </Field>
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose
              render={<Button type="button" variant="outline" />}
              disabled={isPending}
            >
              {t("common:actions.cancel")}
            </DialogClose>
            <Button type="submit" disabled={isPending}>
              {isPending
                ? t("settings:adminUsers.edit.saving")
                : t("settings:adminUsers.edit.save")}
            </Button>
          </DialogFooter>
        </form>
        {/* Outside <form>: a submit inside the window must not reach this form. */}
        {freshSession.dialog}
      </DialogPopup>
    </Dialog>
  );
}
