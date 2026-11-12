import { useTranslation } from "react-i18next";
import { describeActor } from "@/lib/forest/describe-actor";

export function useActorLabel() {
  const { t } = useTranslation();
  return (actorId: string | null) => {
    const actor = describeActor(actorId);
    if (actor.kind === "person") return t("tasks:card.actor.person");
    if (actor.kind === "owner-session")
      return t("tasks:card.actor.ownerSession");
    if (actor.kind === "owner-queue") return t("tasks:card.actor.ownerQueue");
    return actor.label ?? t("tasks:card.actor.agent");
  };
}
