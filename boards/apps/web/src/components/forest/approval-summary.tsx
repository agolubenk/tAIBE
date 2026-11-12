import { useTranslation } from "react-i18next";

type ApprovalSummaryProps = {
  action: string;
  params: Record<string, string> | null;
};

// What the agent asks the owner to allow, in words.
export function ApprovalSummary({ action, params }: ApprovalSummaryProps) {
  const { t } = useTranslation();
  switch (action) {
    case "close_task":
      return (
        <>
          {t("workspace:forest.approvals.action.closeTask", {
            status: params?.status ?? "—",
          })}
        </>
      );
    case "reopen_task":
      return (
        <>
          {t("workspace:forest.approvals.action.reopenTask", {
            status: params?.status ?? "—",
          })}
        </>
      );
    case "set_priority":
      return (
        <>
          {t("workspace:forest.approvals.action.setPriority", {
            priority: params?.priority ?? "—",
          })}
        </>
      );
    case "create_label":
      return (
        <>
          {t("workspace:forest.approvals.action.createLabel", {
            name: params?.name ?? "—",
            count: (params?.taskIds ?? "").split(",").filter(Boolean).length,
          })}
        </>
      );
    case "attach_label":
      return (
        <>
          {t("workspace:forest.approvals.action.attachLabel", {
            name: params?.labelName ?? "—",
            count: (params?.taskIds ?? "").split(",").filter(Boolean).length,
          })}
        </>
      );
    case "set_assignee":
      return (
        <>
          {t("workspace:forest.approvals.action.setAssignee", {
            name: params?.userName ?? params?.userId ?? "—",
          })}
        </>
      );
    case "fell_tree":
      return <>{t("workspace:forest.approvals.action.fellTree")}</>;
    case "fell_sector":
      return <>{t("workspace:forest.approvals.action.fellSector")}</>;
    default:
      return <>{action}</>;
  }
}
