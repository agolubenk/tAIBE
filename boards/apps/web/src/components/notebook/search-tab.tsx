import { Search } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ForestListState } from "@/components/forest/forest-list-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import useNotebookSearch from "@/hooks/queries/notebook/use-notebook-search";
import { SearchResult } from "./search-result";

// Mirrors the API's query limit.
const QUERY_MAX = 500;

// Plain search over the notebook (R-051): the same ranking the chat uses to
// pick its sources, without asking the model.
export function SearchTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const search = useNotebookSearch(workspaceId, query);
  const results = search.data?.results ?? [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setQuery(draft.trim());
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-muted-foreground text-sm">
        {t("workspace:notebook.hints.search")}
      </p>
      <form onSubmit={submit} className="flex gap-2">
        <Input
          type="search"
          aria-label={t("workspace:notebook.search.placeholder")}
          placeholder={t("workspace:notebook.search.placeholder")}
          value={draft}
          maxLength={QUERY_MAX}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" disabled={!draft.trim() || search.isFetching}>
          <Search aria-hidden="true" />
          {t("workspace:notebook.search.submit")}
        </Button>
      </form>
      {query ? (
        <ForestListState
          isLoading={search.isLoading}
          isError={search.isError}
          onRetry={() => void search.refetch()}
          isEmpty={results.length === 0}
          empty={t("workspace:notebook.search.empty")}
        >
          <div className="flex flex-col gap-2">
            {search.data ? (
              <Badge
                variant={search.data.mode === "hybrid" ? "success" : "warning"}
                className="self-start"
              >
                {t(`workspace:notebook.search.mode.${search.data.mode}`)}
              </Badge>
            ) : null}
            <ol className="flex flex-col gap-2">
              {results.map((result) => (
                <SearchResult key={result.chunkId} result={result} />
              ))}
            </ol>
          </div>
        </ForestListState>
      ) : null}
    </div>
  );
}
