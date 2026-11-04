import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import useAddNotebookSource from "@/hooks/mutations/notebook/use-add-notebook-source";
import { addedSourceKind } from "./added-source-kind";

// Mirrors SOURCE_URL_MAX on the API.
const URL_MAX = 2048;

// One field for both kinds: a GitHub PR link goes through the GitHub App, any
// other https link is fetched once as a page.
export function AddSourceForm({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const add = useAddNotebookSource(workspaceId);
  const [url, setUrl] = useState("");
  const trimmed = url.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || add.isPending) return;
    add.mutate(
      { kind: addedSourceKind(trimmed), url: trimmed },
      { onSuccess: () => setUrl("") },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Input
          // Not type="url": the ref form owner/repo#12 is accepted too.
          type="text"
          inputMode="url"
          aria-label={t("workspace:notebook.sources.add.label")}
          placeholder={t("workspace:notebook.sources.add.placeholder")}
          value={url}
          maxLength={URL_MAX}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button type="submit" disabled={!trimmed || add.isPending}>
          {add.isPending ? <Spinner /> : <Plus aria-hidden="true" />}
          {t("workspace:notebook.sources.add.submit")}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {t("workspace:notebook.sources.add.hint")}
      </p>
    </form>
  );
}
