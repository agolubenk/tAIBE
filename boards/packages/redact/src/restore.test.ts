import { describe, expect, it } from "vite-plus/test";
import { redact } from "./index";
import { hasRedactionMarker, redactDeep, restoreRedacted } from "./restore";

// Fake secrets assembled at runtime, so this file holds no key-shaped literal.
const join = (...parts: string[]) => parts.join("");
const KEY_A = join("gh", "p_", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1W");
const KEY_B = join("gh", "p_", "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9D");
const DB = join("postgres", "://", "app:", "s3cr3t", "@db.local:5432/app");

const stored = `deploy with ${KEY_A}\nsample: ${DB}\nbackup ${KEY_B}`;
// What a caller with a token reads.
const masked = redact(stored).text;

describe("restoreRedacted (TB-143)", () => {
  it("puts every value back when each kind keeps its marker count", () => {
    expect(masked).toBe(
      "deploy with [REDACTED:api_key]\nsample: [REDACTED:db_url]\nbackup [REDACTED:api_key]",
    );
    const edited = `${masked}\nnew line from the agent`;

    expect(restoreRedacted(stored, edited)).toEqual({
      ok: true,
      text: `${stored}\nnew line from the agent`,
    });
  });

  it("restores in the order of the new text", () => {
    const moved =
      "backup [REDACTED:api_key]\ndeploy with [REDACTED:api_key]\n[REDACTED:db_url]";

    expect(restoreRedacted(stored, moved)).toEqual({
      ok: true,
      text: `backup ${KEY_A}\ndeploy with ${KEY_B}\n${DB}`,
    });
  });

  it("refuses fewer markers of a kind than stored values", () => {
    const fewer = "deploy with [REDACTED:api_key]\nsample: [REDACTED:db_url]";

    expect(restoreRedacted(stored, fewer)).toEqual({
      ok: false,
      kind: "api_key",
      expected: 2,
      received: 1,
    });
  });

  it("refuses more markers of a kind than stored values", () => {
    const more = `${masked}\n[REDACTED:db_url]`;

    expect(restoreRedacted(stored, more)).toEqual({
      ok: false,
      kind: "db_url",
      expected: 1,
      received: 2,
    });
  });

  it("refuses a kind whose markers were all dropped while others stay", () => {
    const dropped = "deploy with [REDACTED:api_key]\nbackup [REDACTED:api_key]";

    expect(restoreRedacted(stored, dropped)).toEqual({
      ok: false,
      kind: "db_url",
      expected: 1,
      received: 0,
    });
  });

  it("passes text without markers as it is", () => {
    expect(restoreRedacted(stored, "rewritten from scratch")).toEqual({
      ok: true,
      text: "rewritten from scratch",
    });
  });

  it("keeps a marker that the stored text already holds literally", () => {
    const docs = `the API shows [REDACTED:api_key] in place of ${KEY_A}`;
    const view = redact(docs).text;
    expect(view).toBe(
      "the API shows [REDACTED:api_key] in place of [REDACTED:api_key]",
    );

    expect(restoreRedacted(docs, `${view}.`)).toEqual({
      ok: true,
      text: `${docs}.`,
    });
  });

  it("treats a kind it does not know as a marker too", () => {
    expect(
      restoreRedacted("plain", "plain [REDACTED:url_credentials]"),
    ).toEqual({ ok: false, kind: "url_credentials", expected: 0, received: 1 });
  });

  it("does not read $ patterns in a restored value", () => {
    const dollar = `password=${join("p$", "&w$1d")} rest`;
    const view = redact(dollar).text;
    expect(view).toBe("password=[REDACTED:password_assignment] rest");

    expect(restoreRedacted(dollar, view)).toEqual({ ok: true, text: dollar });
  });

  it("finds markers", () => {
    expect(hasRedactionMarker("a [REDACTED:jwt] b")).toBe(true);
    expect(hasRedactionMarker("a [REDACTED:…] b")).toBe(false);
    expect(hasRedactionMarker("plain")).toBe(false);
  });
});

describe("redactDeep (TB-143)", () => {
  it("masks strings at any depth and keeps other values", () => {
    const createdAt = new Date("2026-11-14T08:00:00.000Z");
    const value = {
      id: "task1",
      count: 3,
      done: false,
      empty: null,
      createdAt,
      labels: [{ name: `label ${KEY_A}` }],
      nested: { description: `text ${KEY_B}`, list: [`x ${KEY_A}`, 7] },
    };

    const out = redactDeep(value);

    expect(out).toEqual({
      id: "task1",
      count: 3,
      done: false,
      empty: null,
      createdAt,
      labels: [{ name: "label [REDACTED:api_key]" }],
      nested: {
        description: "text [REDACTED:api_key]",
        list: ["x [REDACTED:api_key]", 7],
      },
    });
    expect(out.createdAt).toBe(createdAt);
    expect(value.labels[0]?.name).toContain(KEY_A);
  });
});
