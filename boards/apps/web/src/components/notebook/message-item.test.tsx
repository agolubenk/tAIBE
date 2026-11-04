import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { citationAnchor } from "./citation-anchor";
import { MessageItem } from "./message-item";
import type { NotebookCitation, NotebookMessage } from "./notebook-types";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const citation: NotebookCitation = {
  n: 1,
  chunkId: "chunk-1",
  kind: "repo-doc",
  ref: "docs/forest.md",
  title: "Лес",
  heading: "Аренда",
};

function message(overrides: Partial<NotebookMessage>): NotebookMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    status: "answered",
    citations: [citation],
    model: null,
    createdAt: "2026-10-28T20:00:00.000Z",
    ...overrides,
  };
}

describe("MessageItem", () => {
  it("turns known markers into buttons that bring the cited source into view", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <MessageItem
        message={message({
          content: "Аренда до 2024 года [1], см. [2024].",
          model: "nvidia/nemotron",
        })}
      />,
    );

    const marker = screen.getByRole("button", { name: "[1]" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText(/см\. \[2024\]\./)).toBeTruthy();
    expect(screen.getByText("nvidia/nemotron")).toBeTruthy();

    const item = document.getElementById(citationAnchor("m1", 1));
    expect(item?.textContent).toContain("Лес");
    expect(item?.textContent).toContain("docs/forest.md");

    fireEvent.click(marker);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(item);
  });

  it("explains a missing answer while still listing the sources", () => {
    render(
      <MessageItem
        message={message({ content: "", status: "retrieval-only" })}
      />,
    );

    expect(
      screen.getByText("workspace:notebook.chat.answerStatus.retrieval-only"),
    ).toBeTruthy();
    expect(document.getElementById(citationAnchor("m1", 1))).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says nothing was found when there are no sources", () => {
    render(
      <MessageItem
        message={message({ status: "retrieval-only", citations: [] })}
      />,
    );

    expect(
      screen.getByText("workspace:notebook.chat.answerStatus.nothingFound"),
    ).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows a brief as written, without source markers or a source list", () => {
    render(
      <MessageItem
        message={message({
          status: "brief",
          content:
            "GOAL: extend the lease [1]\nCONSTRAINTS: none stated\nACCEPTANCE: lease renewed",
          citations: [],
          model: "test-model",
        })}
      />,
    );

    expect(
      screen.getByText("workspace:notebook.chat.brief.title"),
    ).toBeTruthy();
    const brief = screen.getByText(/^GOAL: extend the lease \[1\]/);
    expect(brief.textContent).toBe(
      "GOAL: extend the lease [1]\nCONSTRAINTS: none stated\nACCEPTANCE: lease renewed",
    );
    expect(screen.getByText("test-model")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(
      screen.queryByText("workspace:notebook.chat.answerStatus.nothingFound"),
    ).toBeNull();
  });

  it("says a brief did not come out rather than that nothing was found", () => {
    render(
      <MessageItem
        message={message({
          status: "brief-failed",
          citations: [],
          model: "test-model",
        })}
      />,
    );

    expect(
      screen.getByText("workspace:notebook.chat.brief.failed"),
    ).toBeTruthy();
    expect(
      screen.queryByText("workspace:notebook.chat.answerStatus.nothingFound"),
    ).toBeNull();
  });

  it("shows the reader's question as plain text", () => {
    render(
      <MessageItem
        message={message({
          role: "user",
          content: "<b>Когда</b> аренда?",
          status: null,
          citations: [],
        })}
      />,
    );

    expect(screen.getByText("<b>Когда</b> аренда?")).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });
});
