import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { MAIN_CONTENT_ID, SkipToContent } from "./skip-to-content";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("TB-226: the skip link moves focus to the main content", () => {
  render(
    <>
      <SkipToContent />
      <button type="button">sidebar</button>
      <main id={MAIN_CONTENT_ID} tabIndex={-1}>
        page
      </main>
    </>,
  );

  const link = screen.getByRole("link", {
    name: "navigation:sidebar.skipToContent",
  });
  expect(link.getAttribute("href")).toBe(`#${MAIN_CONTENT_ID}`);

  fireEvent.click(link);

  expect(document.activeElement?.id).toBe(MAIN_CONTENT_ID);
});
