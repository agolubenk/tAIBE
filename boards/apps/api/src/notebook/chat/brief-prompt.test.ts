import { describe, expect, it } from "vite-plus/test";
import {
  BRIEF_MAX_CHARS,
  BRIEF_SYSTEM,
  briefPrompt,
  parseBrief,
  threadText,
} from "./brief-prompt";

const turns = [
  { role: "user" as const, content: "Как продлить аренду карточки?" },
  { role: "assistant" as const, content: "Аренда истекает через час [1]." },
];

describe("briefPrompt", () => {
  it("keeps the DAMS template and fences the thread as data", () => {
    const [system, user] = briefPrompt(turns);

    expect(system?.role).toBe("system");
    for (const line of [
      "GOAL: <one sentence>",
      "CONSTRAINTS: <comma-separated, or 'none stated'>",
      "ACCEPTANCE: <comma-separated checks, or 'none stated'>",
      "Under 80 words total. Never invent requirements absent from the input.",
    ]) {
      expect(BRIEF_SYSTEM).toContain(line);
    }
    expect(system?.content).toBe(BRIEF_SYSTEM);
    expect(user?.role).toBe("user");
    expect(user?.content).toMatch(
      /^<<<ИСТОЧНИКИ-([0-9a-f]{12})\nQ: Как продлить аренду карточки\?\n\nA: Аренда истекает через час \[1\]\.\nИСТОЧНИКИ-\1>>>$/,
    );
  });

  it("removes a secret from the thread before it leaves for the model", () => {
    const leak = "postgresql://app:s3cr3t-pass@db.internal:5432/prod";
    const [, user] = briefPrompt([
      { role: "user", content: `не подключается ${leak}` },
    ]);

    expect(user?.content).not.toContain("s3cr3t-pass");
    expect(user?.content).toContain("не подключается");
  });
});

describe("threadText", () => {
  it("keeps the first question and the latest turns of a long thread", () => {
    const long = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i} ${"слово ".repeat(40)}`,
    }));

    const text = threadText(long, 2000);

    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.startsWith("Q: turn 0 ")).toBe(true);
    expect(text).toContain("\n…\n");
    expect(text).toContain("turn 39");
    expect(text).not.toContain("turn 20 ");
  });
});

describe("parseBrief", () => {
  it("takes a reply in the format and drops the preamble and tags", () => {
    expect(
      parseBrief(
        "Here it is:\n<b>GOAL:</b> extend the lease\nCONSTRAINTS: none stated\nACCEPTANCE: lease renewed",
      ),
    ).toBe(
      "GOAL: extend the lease\nCONSTRAINTS: none stated\nACCEPTANCE: lease renewed",
    );
  });

  it("rejects a reply without GOAL:", () => {
    expect(parseBrief("Аренда истекает через час [1].")).toBeNull();
    expect(parseBrief("<GOAL: hidden in a tag>")).toBeNull();
    expect(parseBrief("goal: lower case")).toBeNull();
  });

  it("caps a reply that ignored max_tokens", () => {
    const brief = parseBrief(`GOAL: ${"x".repeat(5000)}`);

    expect(brief?.length).toBe(BRIEF_MAX_CHARS);
  });
});
