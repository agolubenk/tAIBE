import { usernameProblem } from "@kaneo/permissions";
import { type FocusEvent, useEffect, useId, useRef, useState } from "react";
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
  type LoginProblem,
  saveUsername,
} from "@/lib/username/username-api";

function noticeKey(notice: LoginNotice) {
  if (notice.problem === "rateLimited" && notice.retryAfter) {
    return "settings:informationPage.login.problems.rateLimitedFor" as const;
  }
  return `settings:informationPage.login.problems.${notice.problem}` as const;
}

// Only these stop «Save». After 429 or a lost connection the save itself
// checks the login again, so the person is not stuck until they edit it.
const BLOCKS_SAVE = new Set<LoginProblem>([
  "tooShort",
  "tooLong",
  "invalid",
  "reserved",
  "taken",
]);

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
  const saveId = useId();
  // Grows on each edit and save: a check answer for an older value is dropped.
  const generation = useRef(0);
  const [value, setValue] = useState(current ?? "");
  const [notice, setNotice] = useState<LoginNotice | null>(null);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    generation.current += 1;
    setValue(current ?? "");
    setNotice(null);
    setTouched(false);
  }, [current]);

  const login = value.trim();
  const changed = login !== (current ?? "");
  // The same login in another case is the person's own, not a taken one.
  const ownLogin =
    Boolean(current) && login.toLowerCase() === current?.toLowerCase();
  const ruleProblem = login && changed ? usernameProblem(login) : null;
  // «Too short» waits until the person leaves the field: not on the first letter.
  const shownRule = ruleProblem === "tooShort" && !touched ? null : ruleProblem;
  const shown: LoginNotice | null = shownRule ? { problem: shownRule } : notice;
  const blocked =
    Boolean(ruleProblem) || (notice ? BLOCKS_SAVE.has(notice.problem) : false);
  const canSave = changed && login !== "" && !blocked && !saving;

  const onBlur = async (event: FocusEvent<HTMLInputElement>) => {
    setTouched(true);
    // «Save» checks the login itself: one request, not two.
    if (event.relatedTarget?.id === saveId) return;
    if (!changed || !login || ruleProblem || ownLogin) return;
    const asked = generation.current;
    const answer = await checkUsername(login);
    if (generation.current === asked) setNotice(answer);
  };

  const onSave = async () => {
    setTouched(true);
    if (!canSave) return;
    generation.current += 1;
    const asked = generation.current;
    setSaving(true);
    try {
      await freshSession.run(() => saveUsername(login));
      await refetchUser();
      toast.success(t("settings:informationPage.login.saved"));
    } catch (error) {
      if (isReauthFlowError(error)) return;
      if (generation.current !== asked) return;
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
      {/* One child of SettingsCard: its divide-y draws no line under the row. */}
      <div>
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
                generation.current += 1;
                setValue(event.target.value);
                setNotice(null);
              }}
              onBlur={onBlur}
            />
            <Button
              id={saveId}
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
        {/* A live region from the start: screen readers read each new text. */}
        <p
          id={noteId}
          role="status"
          className={
            shown
              ? "-mt-1.5 px-4 pb-3 text-xs text-destructive"
              : "-mt-1.5 px-4 pb-3 text-xs text-muted-foreground"
          }
        >
          {note}
        </p>
      </div>
      {freshSession.dialog}
    </>
  );
}
