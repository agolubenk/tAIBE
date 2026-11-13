import { useTranslation } from "react-i18next";

type SourceAuthorProps = {
  kind: "agent" | "person" | null;
  name: string | null;
};

// TB-115: who added a link or a pull request. An agent's name carries its
// session; a source added before authors were kept says «unknown».
export function SourceAuthor({ kind, name }: SourceAuthorProps) {
  const { t } = useTranslation();
  const text =
    kind && name
      ? t(
          kind === "agent"
            ? "workspace:notebook.sources.addedByAgent"
            : "workspace:notebook.sources.addedByPerson",
          { name },
        )
      : t("workspace:notebook.sources.addedByUnknown");

  return (
    <span className="truncate text-muted-foreground text-xs" title={text}>
      {text}
    </span>
  );
}
