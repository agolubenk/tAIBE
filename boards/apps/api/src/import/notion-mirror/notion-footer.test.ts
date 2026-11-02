import type { ImportedTask } from "@kaneo/importers";
import { describe, expect, it } from "vite-plus/test";
import { footerOf, readNotionFooter, withNotionFooter } from "./notion-footer";

// The reconciliation's own pattern (role 2, compare.py), in Python syntax.
const PY_FOOTER = /(?:^|\n\n)Notion: (\{.*\})[ \t]*$/;

const task = (footer: ImportedTask["footer"]) =>
  ({ key: "k", footer }) as unknown as ImportedTask;

describe("withNotionFooter", () => {
  it("puts the footer last, after a blank line, as compact JSON", () => {
    const body = withNotionFooter("Body\n", {
      "Task ID": "T-12",
      Очередь: "w-n-ats-all · ATS и кандидаты: задачи — без срока",
    });
    expect(body).toBe(
      'Body\n\nNotion: {"Task ID":"T-12","Очередь":"w-n-ats-all · ATS и кандидаты: задачи — без срока"}',
    );
    expect(JSON.parse(PY_FOOTER.exec(body)?.[1] ?? "")).toEqual({
      "Task ID": "T-12",
      Очередь: "w-n-ats-all · ATS и кандидаты: задачи — без срока",
    });
  });

  it("makes the footer the only line of an empty body", () => {
    const body = withNotionFooter("", { "Council readiness": 87.5 });
    expect(body).toBe('Notion: {"Council readiness":87.5}');
    expect(readNotionFooter(body)).toEqual({ "Council readiness": 87.5 });
  });

  it("gives the same body when written twice", () => {
    const footer = { "Bug ID": "B-41", "Council readiness": 0.72 };
    const once = withNotionFooter("Text", footer);
    expect(withNotionFooter(once, footer)).toBe(once);
  });

  it("leaves a body without footer fields as it is", () => {
    expect(withNotionFooter("Text", {})).toBe("Text");
    expect(readNotionFooter("Text")).toBeNull();
  });

  it("writes markup in values as JSON escapes, which read back raw", () => {
    const footer = {
      Очередь: "<img src=x onerror=alert(1)> [a](javascript:x) &lt; \\",
    };
    const body = withNotionFooter("Text", footer);
    expect(body).toBe(
      'Text\n\nNotion: {"Очередь":"\\u003cimg src=x onerror=alert(1)\\u003e \\u005ba\\u005d(javascript:x) \\u0026lt; \\\\"}',
    );
    expect(readNotionFooter(body)).toEqual(footer);
    expect(JSON.parse(PY_FOOTER.exec(body)?.[1] ?? "")).toEqual(footer);
  });

  it("keeps values raw, spaces included", () => {
    const body = withNotionFooter("Text", { "Backlog ID": " FIX-07 " });
    expect(readNotionFooter(body)).toEqual({ "Backlog ID": " FIX-07 " });
  });
});

describe("footerOf", () => {
  const footer = { "Task ID": "T-1", "Backlog ID": "FIX-07" };

  it("drops the Backlog ID a card keeps in its meta", () => {
    expect(footerOf(task(footer), true)).toEqual({ "Task ID": "T-1" });
  });

  it("keeps the Backlog ID a card could not take", () => {
    expect(footerOf(task(footer), false)).toEqual(footer);
  });
});
