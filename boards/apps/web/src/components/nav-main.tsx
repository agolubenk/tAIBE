import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  CircleCheck,
  House,
  Inbox,
  type LucideIcon,
  Mail,
  NotebookText,
  Trees,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import useApprovals from "@/hooks/queries/forest/use-approvals";
import { usePendingInvitations } from "@/hooks/queries/invitation/use-pending-invitations";
import useGetNotifications from "@/hooks/queries/notification/use-get-notifications";
import useGetAssignedTasks from "@/hooks/queries/task/use-get-assigned-tasks";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";
import { cn } from "@/lib/cn";

type NavItem = {
  title: string;
  icon: LucideIcon;
  url: string;
  count?: number;
  emphasizeCount?: boolean;
};

export function NavMain() {
  const { t } = useTranslation();
  const { data: workspace } = useActiveWorkspace();
  const navigate = useNavigate();
  const pathname = useLocation({
    select: (location) => location.pathname.replace(/\/+$/, ""),
  });
  const { data: invitations = [] } = usePendingInvitations();
  const { data: notifications = [] } = useGetNotifications(workspace?.id);
  const { data: assignedTasks } = useGetAssignedTasks(workspace?.id, true);
  const { data: pendingApprovals } = useApprovals(
    workspace?.id ?? "",
    "pending",
  );

  if (!workspace) return null;

  const homeUrl = `/dashboard/workspace/${workspace.id}`;
  const unreadCount = notifications.filter(
    (notification) => !notification.isRead,
  ).length;

  const navItems: NavItem[] = [
    { title: t("navigation:sidebar.home"), icon: House, url: homeUrl },
    {
      title: t("navigation:sidebar.inbox"),
      icon: Inbox,
      url: `${homeUrl}/inbox`,
      count: unreadCount,
      emphasizeCount: true,
    },
    {
      title: t("navigation:sidebar.myTasks"),
      icon: CircleCheck,
      url: `${homeUrl}/my-tasks`,
      count: assignedTasks?.total,
    },
    {
      title: t("navigation:sidebar.forest"),
      icon: Trees,
      url: `${homeUrl}/forest`,
      // Requests waiting for the owner's «да».
      count: pendingApprovals?.items.length,
      emphasizeCount: true,
    },
    {
      title: t("navigation:sidebar.notebook"),
      icon: NotebookText,
      url: `${homeUrl}/notebook`,
    },
    {
      title: t("navigation:sidebar.members"),
      icon: Users,
      url: `${homeUrl}/members`,
    },
  ];

  // Invitations to other workspaces only matter while one is waiting.
  if (invitations.length > 0) {
    navItems.push({
      title: t("navigation:sidebar.invitations"),
      icon: Mail,
      url: "/dashboard/invitations",
      count: invitations.length,
      emphasizeCount: true,
    });
  }

  return (
    <SidebarGroup className="gap-1 p-2">
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {navItems.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                tooltip={item.title}
                isActive={pathname === item.url}
                size="default"
                className="h-8 text-sm"
                onClick={() => navigate({ to: item.url })}
              >
                <item.icon aria-hidden="true" />
                {/* A long label (SSR) is cut on a narrow sidebar: the full text
                    stays in the native hint (TB-226). */}
                <span className="min-w-0 truncate" title={item.title}>
                  {item.title}
                </span>
                {item.count ? (
                  <span
                    className={cn(
                      "ml-auto flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] tabular-nums",
                      item.emphasizeCount
                        ? "bg-foreground font-semibold text-background"
                        : "font-medium text-muted-foreground",
                    )}
                  >
                    {item.count > 99 ? "99+" : item.count}
                  </span>
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
