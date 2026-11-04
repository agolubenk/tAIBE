import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import useUpdateCardMeta from "@/hooks/mutations/forest/use-update-card-meta";
import { useResetOnOpen } from "@/hooks/use-reset-on-open";
import type { CardMeta } from "./card-types";
import { type MetaDraft, draftToPatch, toMetaDraft } from "./meta-draft";
import { MetaTextField } from "./meta-text-field";

type CardMetaDialogProps = {
  workspaceId: string;
  taskId: string;
  meta: CardMeta;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CardMetaDialog({
  workspaceId,
  taskId,
  meta,
  open,
  onOpenChange,
}: CardMetaDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MetaDraft>(() => toMetaDraft(meta));
  useResetOnOpen(open, () => setDraft(toMetaDraft(meta)));
  const update = useUpdateCardMeta(workspaceId, taskId);
  const { patch, invalid } = draftToPatch(meta, draft);
  const changed = Object.keys(patch).length > 0;
  // The server says when the card's Notion fields are read-only: only while
  // the Notion mirror runs for the workspace (R-081). A card imported long
  // ago is fully editable once the mirror is off (R-084).
  const mirrored = Boolean(meta.mirrored);

  const set =
    <K extends keyof MetaDraft>(key: K) =>
    (value: MetaDraft[K]) =>
      setDraft((current) => ({ ...current, [key]: value }));

  const save = () => {
    if (!changed || invalid.length) return;
    update.mutate(
      { workspaceId, taskId, patch },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("tasks:card.edit.title")}</DialogTitle>
          <DialogDescription>
            {mirrored
              ? t("tasks:card.edit.mirrored")
              : t("tasks:card.edit.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="card-meta-form"
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <fieldset className="flex flex-col gap-3" disabled={mirrored}>
              <legend className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {t("tasks:card.sections.notion")}
              </legend>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-xs">
                  {t("tasks:card.fields.kind")}
                </span>
                <ToggleGroup
                  variant="outline"
                  size="sm"
                  value={[draft.kind]}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "task" || next === "bug") set("kind")(next);
                  }}
                >
                  <ToggleGroupItem value="task" disabled={mirrored}>
                    {t("tasks:card.kind.task")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="bug" disabled={mirrored}>
                    {t("tasks:card.kind.bug")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="flex flex-col gap-0.5">
                  <label
                    htmlFor="card-half-baked"
                    className="font-medium text-xs"
                  >
                    {t("tasks:card.fields.halfBaked")}
                  </label>
                  <span
                    id="card-half-baked-hint"
                    className="text-muted-foreground text-xs"
                  >
                    {t("tasks:card.edit.halfBakedHint")}
                  </span>
                </span>
                <Switch
                  id="card-half-baked"
                  aria-describedby="card-half-baked-hint"
                  checked={draft.halfBaked}
                  disabled={mirrored}
                  onCheckedChange={set("halfBaked")}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <MetaTextField
                  id="card-severity"
                  label={t("tasks:card.fields.severity")}
                  value={draft.severity}
                  disabled={mirrored}
                  onChange={set("severity")}
                />
                <MetaTextField
                  id="card-backlog-id"
                  label={t("tasks:card.fields.backlogId")}
                  value={draft.backlogId}
                  disabled={mirrored}
                  onChange={set("backlogId")}
                />
              </div>
              <MetaTextField
                id="card-report"
                label={t("tasks:card.fields.report")}
                value={draft.report}
                disabled={mirrored}
                multiline
                onChange={set("report")}
              />
            </fieldset>

            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {t("tasks:card.sections.agent")}
              </legend>
              <div className="grid grid-cols-2 gap-3">
                <MetaTextField
                  id="card-executor"
                  label={t("tasks:card.fields.executor")}
                  value={draft.executor}
                  onChange={set("executor")}
                />
                <MetaTextField
                  id="card-branch"
                  label={t("tasks:card.fields.branch")}
                  value={draft.branch}
                  onChange={set("branch")}
                />
              </div>
              <MetaTextField
                id="card-pull-requests"
                label={t("tasks:card.fields.pullRequests")}
                hint={t("tasks:card.edit.onePerLine")}
                value={draft.pullRequests}
                multiline
                onChange={set("pullRequests")}
              />
              <MetaTextField
                id="card-files"
                label={t("tasks:card.fields.files")}
                hint={t("tasks:card.edit.onePerLine")}
                value={draft.files}
                multiline
                onChange={set("files")}
              />
              <div className="grid grid-cols-2 gap-3">
                <MetaTextField
                  id="card-tokens"
                  label={t("tasks:card.fields.tokens")}
                  value={draft.tokens}
                  inputMode="numeric"
                  invalid={invalid.includes("tokens")}
                  onChange={set("tokens")}
                />
                <MetaTextField
                  id="card-cost"
                  label={t("tasks:card.fields.cost")}
                  value={draft.costUsd}
                  inputMode="decimal"
                  invalid={invalid.includes("costUsd")}
                  onChange={set("costUsd")}
                />
              </div>
              <MetaTextField
                id="card-context-pack"
                label={t("tasks:card.fields.contextPack")}
                value={draft.contextPack}
                multiline
                onChange={set("contextPack")}
              />
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="submit"
            form="card-meta-form"
            disabled={!changed || invalid.length > 0 || update.isPending}
          >
            {t("tasks:card.edit.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
