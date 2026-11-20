import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Timeline } from "../ui/timeline";
import type { DialogEntry } from "./group-dialogs";
import { SessionDialog } from "./session-dialog";

afterEach(cleanup);

vi.mock("./index", () => ({
  default: ({ activity }: { activity: { content: string | null } }) => (
    <div>{activity.content}</div>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) =>
      `${key}${values ? ` ${Object.values(values).join("/")}` : ""}`,
  }),
}));

const message = (id: string, content: string) => ({
  id,
  content,
  type: "comment",
  createdAt: "2026-11-13T20:00:00Z",
  userId: "u1",
  taskId: "t1",
  eventData: null,
});

function dialog(open: boolean): DialogEntry<ReturnType<typeof message>> {
  return {
    kind: "dialog",
    key: "pair#1",
    open,
    sessions: ["writer", "reviewer"],
    messages: [message("a", "writer: plan"), message("b", "reviewer: ok")],
  };
}

function mount(open: boolean) {
  return render(
    <Timeline>
      <SessionDialog dialog={dialog(open)} step={1} />
    </Timeline>,
  );
}

describe("SessionDialog (TB-11)", () => {
  it("shows an open dialog inline with its sessions and messages", () => {
    mount(true);
    const section = screen.getByRole("region", {
      name: "activity:dialog.title",
    });
    expect(section.textContent).toContain("activity:dialog.live");
    expect(screen.getByText("writer")).toBeTruthy();
    expect(screen.getByText("reviewer")).toBeTruthy();
    expect(screen.getByText("activity:dialog.summary 2/2")).toBeTruthy();
    expect(screen.getByText("writer: plan")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("folds an archived dialog to one row that opens", () => {
    mount(false);
    const toggle = screen.getByRole("button");
    expect(toggle.textContent).toContain("activity:dialog.archived");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("writer: plan")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("writer: plan")).toBeTruthy();
    expect(screen.getByText("reviewer: ok")).toBeTruthy();
  });
});
