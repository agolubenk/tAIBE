import { readFileSync } from "node:fs";
import { formTemplateSchema } from "@kaneo/forms";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FormRenderer } from "./form-renderer";
import { sevenTypesTemplate as template } from "./form-test-template";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const question = (name: string) => {
  const item = screen
    .getAllByRole("listitem")
    .find((li) => li.querySelector("p")?.textContent?.startsWith(name));
  if (!item) throw new Error(`no question ${name}`);
  return within(item);
};

describe("FormRenderer (TB-173)", () => {
  it("draws the 53 questions of the grill template", () => {
    const grill = formTemplateSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../../../../../packages/forms/fixtures/t-boards-grill.form.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    render(
      <FormRenderer answers={{}} onAnswerChange={vi.fn()} template={grill} />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(53);
  });

  it("shows a field only while its display rule holds", () => {
    const onAnswerChange = vi.fn();
    const { rerender } = render(
      <FormRenderer
        answers={{}}
        onAnswerChange={onAnswerChange}
        template={template}
      />,
    );
    expect(screen.queryByText("Team size")).toBeNull();
    fireEvent.click(
      question("Do you have a team?").getByRole("radio", {
        name: "tasks:forms.yes",
      }),
    );
    expect(onAnswerChange).toHaveBeenCalledWith("team", { v: true });

    rerender(
      <FormRenderer
        answers={{ team: { v: true } }}
        onAnswerChange={onAnswerChange}
        template={template}
      />,
    );
    expect(screen.getByText("Team size")).toBeTruthy();
  });

  it("gives option indexes for a choice, a scale and a matrix row", () => {
    const onAnswerChange = vi.fn();
    render(
      <FormRenderer
        answers={{ grid: { v: [1, null] } }}
        onAnswerChange={onAnswerChange}
        template={template}
      />,
    );
    fireEvent.click(question("Plan").getByRole("radio", { name: "Pro" }));
    expect(onAnswerChange).toHaveBeenCalledWith("plan", { v: 1 });

    fireEvent.click(question("Mood").getByRole("radio", { name: "4" }));
    expect(onAnswerChange).toHaveBeenCalledWith("mood", { v: 4 });

    const price = question("Grid").getAllByRole("radiogroup")[1];
    if (!price) throw new Error("no second row");
    fireEvent.click(within(price).getByRole("radio", { name: "Low" }));
    expect(onAnswerChange).toHaveBeenCalledWith("grid", { v: [1, 0] });
  });

  it("names each matrix row by the question and the row", () => {
    render(
      <FormRenderer
        answers={{}}
        onAnswerChange={vi.fn()}
        template={template}
      />,
    );
    const rows = question("Grid").getAllByRole("radiogroup");
    expect(rows.map((row) => row.getAttribute("aria-labelledby"))).toEqual([
      expect.stringMatching(/-q .*-row-0$/),
      expect.stringMatching(/-q .*-row-1$/),
    ]);
  });

  it("keeps a typed number as text and answers a number or null", () => {
    const onAnswerChange = vi.fn();
    render(
      <FormRenderer
        answers={{ team: { v: true } }}
        onAnswerChange={onAnswerChange}
        template={template}
      />,
    );
    const size = question("Team size").getByRole("textbox");
    fireEvent.change(size, { target: { value: "-" } });
    expect(onAnswerChange).toHaveBeenLastCalledWith("size", { v: null });
    expect((size as HTMLInputElement).value).toBe("-");
    fireEvent.change(size, { target: { value: "1,5" } });
    expect(onAnswerChange).toHaveBeenLastCalledWith("size", { v: 1.5 });
  });

  it("answers one end of a date interval", () => {
    const onAnswerChange = vi.fn();
    const { container } = render(
      <FormRenderer
        answers={{}}
        onAnswerChange={onAnswerChange}
        template={template}
      />,
    );
    const [from] = container.querySelectorAll('input[type="date"]');
    if (!from) throw new Error("no date input");
    fireEvent.change(from, { target: { value: "2026-11-15" } });
    expect(onAnswerChange).toHaveBeenCalledWith("dates", {
      v: ["2026-11-15", null],
    });
  });

  it("shows the text of an issue code next to its question", () => {
    render(
      <FormRenderer
        answers={{}}
        issues={[{ fieldId: "name", code: "required" }]}
        onAnswerChange={vi.fn()}
        template={template}
      />,
    );
    expect(
      question("Name").getByText("tasks:forms.issues.required"),
    ).toBeTruthy();
    expect(
      question("Name").getByRole("textbox").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("opens a note and answers it", () => {
    const onAnswerChange = vi.fn();
    render(
      <FormRenderer
        answers={{}}
        onAnswerChange={onAnswerChange}
        template={template}
      />,
    );
    const story = question("Story");
    fireEvent.click(story.getByRole("button", { name: "tasks:forms.addNote" }));
    fireEvent.change(story.getByRole("textbox", { name: "tasks:forms.note" }), {
      target: { value: "later" },
    });
    expect(onAnswerChange).toHaveBeenCalledWith("story", { note: "later" });
  });

  it("renders template text as text, not HTML", () => {
    const html = formTemplateSchema.parse({
      ...template,
      fields: [{ id: "x", type: "yesno", q: "<b>bold</b>" }],
    });
    const { container } = render(
      <FormRenderer answers={{}} onAnswerChange={vi.fn()} template={html} />,
    );
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>bold</b>")).toBeTruthy();
  });
});
