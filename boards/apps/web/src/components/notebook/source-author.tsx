import { useTranslation } from "react-i18next";

type SourceAuthorProps = {
  kind: "agent" | "person" | null;
  name: string | null;
};

// TB-115: who added a link or a pull request. An agent's name carries its
// session; an agent without a name is «an agent» (the server never stores a
// token's internal id), a member without a name «a member» (nor their email);
// a source added before authors were kept says «unknown».
export function SourceAuthor({ kind, name }: SourceAuthorProps) {
  const { t } = useTranslation();
  const text =
    kind === "agent"
      ? name
        ? t("workspace:notebook.sources.addedByAgent", { name })
        : t("workspace:notebook.sources.addedByNamelessAgent")
      : kind === "person"
        ? name
          ? t("workspace:notebook.sources.addedByPerson", { name })
          : t("workspace:notebook.sources.addedByMember")
        : t("workspace:notebook.sources.addedByUnknown");

  return (
    <span className="truncate text-muted-foreground text-xs" title={text}>
      {text}
    </span>
  );
}
