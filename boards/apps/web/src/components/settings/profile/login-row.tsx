import { usernameProblem } from "@kaneo/permissions";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFreshSession } from "@/components/reauth/use-fresh-session";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isReauthFlowError } from "@/lib/reauth/reauth-errors";
import { toast } from "@/lib/toast";
import {
  checkUsername,
  LoginSaveError,
  type LoginNotice,
  saveUsername,
} from "@/lib/username/username-api";

function noticeKey(notice: LoginNotice) {
  if (notice.problem === "rateLimited" && notice.retryAfter) {
    return "settings:informationPage.login.problems.rateLimitedFor" as const;
  }
  return `settings:informationPage.login.problems.${notice.problem}` as const;
}

type LoginRowProps = {
  // As the person typed it (`displayUsername`), or the stored lower-case login.
  current: string | null | undefined;
  refetchUser: () => Promise<unknown>;
};

/**
 * TB-31 R-1: the login is saved by a button, not by itself like the name
 * next to it. The rule and the reserved names are checked in the browser; the
 * server is asked once, when the person leaves the field or saves.
 */
export function LoginRow({ current, refetchUser }: LoginRowProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const noteId = useId();
  const freshSession = useFreshSession();
  const [value, setValue] = useState(current ?? "");
  const [notice, setNotice] = useState<LoginNotice | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(current ?? "");
    setNotice(null);
  }, [current]);

  const login = value.trim();
  const changed = login !== (current ?? "");
  // The same login in another case is the person's own, not a taken one.
  const ownLogin =
    Boolean(current) && login.toLowerCase() === current?.toLowerCase();
  const ruleProblem = login && changed ? usernameProblem(login) : null;
  const shown: LoginNotice | null = ruleProblem
    ? { problem: ruleProblem }
    : notice;
  const canSave = changed && login !== "" && !shown && !saving;

  const onBlur = async () => {
    if (!changed || !login || ruleProblem || ownLogin) return;
    setNotice(await checkUsername(login));
  };

  const onSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await freshSession.run(() => saveUsername(login));
      await refetchUser();
      toast.success(t("settings:informationPage.login.saved"));
    } catch (error) {
      if (isReauthFlowError(error)) return;
      setNotice(
        error instanceof LoginSaveError ? error.notice : { problem: "failed" },
      );
    } finally {
      setSaving(false);
    }
  };

  const note = shown
    ? t(noticeKey(shown), { seconds: shown.retryAfter })
    : t(
        current
          ? "settings:informationPage.login.saveHint"
          : "settings:informationPage.login.emptyHint",
      );

  return (
    <>
      <SettingsRow
        stack
        title={
          <Label htmlFor={inputId}>
            {t("settings:informationPage.login.label")}
          </Label>
        }
      >
        <div className="flex w-full gap-2 sm:w-auto">
          <Input
            id={inputId}
            size="sm"
            className="min-w-0 flex-1 sm:w-48"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t("settings:informationPage.login.placeholder")}
            value={value}
            aria-invalid={shown ? true : undefined}
            aria-describedby={noteId}
            onChange={(event) => {
              setValue(event.target.value);
              setNotice(null);
            }}
            onBlur={onBlur}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!canSave}
            loading={saving}
            onClick={onSave}
          >
            {t("settings:informationPage.login.save")}
          </Button>
        </div>
      </SettingsRow>
      <p
        id={noteId}
        role={shown ? "alert" : undefined}
        className={
          shown
            ? "-mt-1.5 px-4 pb-3 text-xs text-destructive"
            : "-mt-1.5 px-4 pb-3 text-xs text-muted-foreground"
        }
      >
        {note}
      </p>
      {freshSession.dialog}
    </>
  );
}
