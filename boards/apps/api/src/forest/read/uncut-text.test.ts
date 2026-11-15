import { redact } from "@kaneo/redact";
import { describe, expect, it } from "vite-plus/test";
import { buildLog, HISTORY_CONTENT_CHARS } from "../fell/build-log";
import {
  buildSeeds,
  SEED_BODY_CHARS,
  SEED_TRUNCATED,
} from "../fell/build-seeds";
import type { FelledTask, TreeMaterial } from "../fell/tree-material";
import { uncutClips, uncutText } from "./uncut-text";

// Fake secrets assembled at runtime, so this file holds no key-shaped
// literal. The filler is Cyrillic, so a visible run of 3 characters of a
// value is a piece of it.
const join = (...parts: string[]) => parts.join("");
const value = (n: number, seed: number) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[(i * 7 + seed * 13 + ((i * i) % 11)) % alphabet.length];
  }
  return out;
};
// Secrets that redact knows by their whole shape. A key name before a value
// (`DB_PASSWORD=`, `Bearer`) masks a cut value as well, so it is not here.
const SECRETS = [
  { name: "ghp_ token", secret: join("gh", "p_", value(36, 1)) },
  {
    name: "JWT",
    secret: join("ey", "J", value(20, 7), ".", value(40, 8), ".", value(19, 9)),
  },
  {
    name: "URL with a password",
    secret: `${join("postgres", "://app:")}${value(11, 4)}@db.internal:5432/app`,
    value: value(11, 4),
  },
].map((s) => ({ ...s, value: s.value ?? s.secret }));

const filler = (n: number) => {
  let out = "";
  while (out.length < n) out += "слово ";
  return `${out.slice(0, n - 1)} `;
};

const MARKER = /\[REDACTED:[a-z0-9_]+\]/g;
function visible(text: string, secret: string) {
  const shown = text.replace(MARKER, " ");
  for (let i = 0; i + 3 <= secret.length; i++) {
    if (shown.includes(secret.slice(i, i + 3))) return true;
  }
  return false;
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 6, minute));
function task(id: string, number: number, title: string): FelledTask {
  return {
    id,
    projectId: "p1",
    number,
    title,
    description: null,
    status: "done",
    priority: "medium",
    userId: null,
    columnId: null,
    startDate: null,
    dueDate: null,
    createdAt: at(number),
    updatedAt: at(number),
    revision: 1,
  };
}

// A root with one branch and one twig. The branch holds the description
// and the comment, the twig title fills the body up to its cut.
function tree(parts: {
  description?: string;
  comment?: string;
  twigTitle?: string;
  rootComment?: string;
}): TreeMaterial {
  const root = task("root", 1, "Корень");
  const branch = {
    ...task("b", 2, "Ветка"),
    description: parts.description ?? null,
  };
  const twig = task("t", 3, parts.twigTitle ?? "Побег");
  const comment = (taskId: string, content: string, minute: number) => ({
    taskId,
    type: "comment",
    content,
    userId: "u1",
    createdAt: at(minute),
    eventData: null,
  });
  return {
    root,
    projectName: "Лес",
    tasks: [root, branch, twig],
    edges: [
      { parentId: "root", childId: "b" },
      { parentId: "b", childId: "t" },
    ],
    activities: [
      ...(parts.comment ? [comment("b", parts.comment, 4)] : []),
      ...(parts.rootComment ? [comment("root", parts.rootComment, 5)] : []),
    ],
    labels: [],
    assets: [],
    outerLinks: [],
  };
}

const seedBody = (material: TreeMaterial) => buildSeeds(material)[0].body;

// Each clip of felling, with the secret `shift` characters before its cut.
const CLIPS: {
  name: string;
  text: (secret: string, shift: number) => string;
}[] = [
  {
    name: "description at 800",
    text: (secret, shift) =>
      seedBody(tree({ description: `${filler(800 - shift)}${secret} хвост` })),
  },
  {
    name: "comment at 300",
    text: (secret, shift) =>
      seedBody(tree({ comment: `${filler(300 - shift)}${secret} хвост` })),
  },
  {
    name: `body at ${SEED_BODY_CHARS}`,
    text: (secret, shift) => {
      const mark = "ПОБЕГ";
      const start = seedBody(tree({ twigTitle: mark })).indexOf(mark);
      const cut = SEED_BODY_CHARS - SEED_TRUNCATED.length;
      const title = `${filler(cut - start - shift)}${secret} ${filler(400)}`;
      return seedBody(tree({ twigTitle: title }));
    },
  },
];

describe("uncutText (TB-203)", () => {
  it("keeps a text shorter than the cut and reads a cut text to its last space", () => {
    expect(uncutText("один два", 10)).toBe("один два");
    expect(uncutText("один два", 8)).toBe("один");
    expect(uncutText("одно", 4)).toBe("");
  });

  it.each(SECRETS)(
    "shows no part of a $name cut in a history entry",
    ({ secret, value: shown }) => {
      let leakedAlone = 0;
      for (let shift = 1; shift < secret.length; shift++) {
        const rootComment = `${filler(HISTORY_CONTENT_CHARS - shift)}${secret} хвост`;
        const [entry] = buildLog(tree({ rootComment })).history;
        const content = entry.content as string;
        expect(content).toHaveLength(HISTORY_CONTENT_CHARS);
        if (visible(redact(content).text, shown)) leakedAlone++;
        const read = redact(uncutText(content, HISTORY_CONTENT_CHARS)).text;
        expect(visible(read, shown), `shift ${shift}`).toBe(false);
      }
      // Not vacuous: masked without the uncut, a cut secret shows.
      expect(leakedAlone).toBeGreaterThan(0);
    },
  );
});

describe("uncutClips (TB-203)", () => {
  it("keeps a seed body with no clip", () => {
    const body = seedBody(tree({ description: "Короткое описание" }));
    expect(body).not.toContain("…");
    expect(uncutClips(body)).toBe(body);
  });

  for (const clip of CLIPS) {
    it.each(SECRETS)(
      `shows no part of a $name cut by the ${clip.name}`,
      ({ secret, value: shown }) => {
        let leakedAlone = 0;
        for (let shift = 1; shift < secret.length; shift++) {
          const body = clip.text(secret, shift);
          expect(body.includes("…"), `shift ${shift}`).toBe(true);
          if (visible(redact(body).text, shown)) leakedAlone++;
          const read = redact(uncutClips(body)).text;
          expect(visible(read, shown), `shift ${shift}`).toBe(false);
        }
        expect(leakedAlone).toBeGreaterThan(0);
      },
    );
  }

  it("keeps the clip marks and the text before them", () => {
    const body = seedBody(
      tree({
        description: `${filler(810)}хвост`,
        comment: `${filler(310)}хвост`,
      }),
    );
    const read = uncutClips(body);
    expect(read.match(/…/g)).toHaveLength(2);
    expect(read).toContain("## Discussion\n- слово");
    expect(read.length).toBeGreaterThan(body.length - 20);
  });
});
