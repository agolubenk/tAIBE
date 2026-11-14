import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { looksLikeSecret, redact } from "./index";

// TB-136: one corpus for both rule sets. infra/checks/test_checks.py reads the
// same file and expects the scanner rule `scan` on every case.
type CorpusCase = {
  id: string;
  kind: string;
  before: string;
  value: string[];
  after: string;
  redact: string;
  scan: string;
};
const corpus = JSON.parse(
  readFileSync(
    new URL("../fixtures/secrets-corpus.json", import.meta.url),
    "utf8",
  ),
) as { cases: CorpusCase[] };

// Test secrets are assembled at runtime from fragments so this file carries
// no string that a secret scanner could mistake for live material.
function join(...parts: string[]): string {
  return parts.join("");
}

const secrets = {
  openai: join("sk", "-", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4"),
  anthropic: join("sk", "-ant-", "x9Y8w7V6u5T4s3R2q1P0o9N8m7"),
  ghp: join("gh", "p_", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1W"),
  gho: join("gh", "o_", "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe"),
  githubPat: join(
    "github",
    "_pat_",
    "11ABCDEFGH22",
    "_",
    "Za9Yb8Xc7Wd6Ve5Uf4Tg3Sh2Ri1Qj0Pk9Ol8Nm7Mn6Lk5J",
  ),
  slackBot: join("xox", "b-", "123456789012", "-", "abcdefABCDEF"),
  aws: join("AK", "IA", "IOSFODNN7EXAMPLE"),
  gitlab: join("gl", "pat-", "AbCdEfGhIjKlMnOpQrSt"),
  google: join("AI", "za", "SyD4eF6gH8jK0lM2nB4vC6xZ8aS0dF2gH4j"),
  jwt: join(
    "eyJ",
    "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    ".eyJ",
    "zdWIiOiIxMjM0NTY3ODkwIn0",
    ".",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
  ),
  pem: join(
    "-----BEGIN ",
    "PRIVATE KEY-----",
    "\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASC",
    "BKwwggjkAgEAAoIBAQC7\n",
    "-----END ",
    "PRIVATE KEY-----",
  ),
  postgresUrl: join(
    "postgres",
    "://",
    "app",
    ":",
    "s3cr3t",
    "@db.internal:5432/prod",
  ),
  redisUrl: join("redis", "://", ":", "s3cr3t", "@cache.internal:6379"),
  mongoUrl: join(
    "mongodb",
    "+srv",
    "://",
    "app",
    ":",
    "s3cr3t",
    "@cluster0.example.net/db",
  ),
  bearer: join("Authorization", ": ", "Bearer", " ", "mF_9.B5f-4.1JqM"),
  base64Blob: join(
    "bW91",
    "bnRhaW5zLWFyZS1oaWdoLWFuZC13aWxkLXNlY3JldHMtYXJl",
    "LWRlZXAtdGhlLXRva2Vucy1hcmUtd2lkZS1hbmQtbG9uZw",
  ),
};

function expectSingleHit(
  input: string,
  kind: string,
  secret: string,
): { text: string; hits: { kind: string; start: number; end: number }[] } {
  const result = redact(input);
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]?.kind).toBe(kind);
  expect(result.hits[0]?.start).toBe(input.indexOf(secret));
  expect(result.hits[0]?.end).toBe(input.indexOf(secret) + secret.length);
  expect(result.text).toBe(input.replace(secret, `[REDACTED:${kind}]`));
  expect(result.text).not.toContain(secret);
  return result;
}

describe("@kaneo/redact", () => {
  describe("api_key", () => {
    it.each([
      ["OpenAI", secrets.openai],
      ["Anthropic", secrets.anthropic],
      ["GitHub classic", secrets.ghp],
      ["GitHub OAuth", secrets.gho],
      ["GitHub fine-grained", secrets.githubPat],
      ["Slack", secrets.slackBot],
      ["AWS", secrets.aws],
      ["GitLab", secrets.gitlab],
      ["Google", secrets.google],
    ])("redacts %s keys", (_name, secret) => {
      expectSingleHit(`token = ${secret} `, "api_key", secret);
    });
  });

  it("redacts JWTs", () => {
    expectSingleHit(`jwt: ${secrets.jwt}\n`, "jwt", secrets.jwt);
  });

  it("redacts PEM blocks including newlines", () => {
    expectSingleHit(`key file:\n${secrets.pem}\nend`, "pem", secrets.pem);
  });

  describe("db_url", () => {
    it.each([
      ["postgres", secrets.postgresUrl],
      ["redis", secrets.redisUrl],
      ["mongodb+srv", secrets.mongoUrl],
    ])("redacts %s connection strings", (_name, secret) => {
      expectSingleHit(`DATABASE_URL=${secret}\n`, "db_url", secret);
    });
  });

  it("redacts bearer tokens but keeps the header name", () => {
    expectSingleHit(`header ${secrets.bearer}`, "bearer", "mF_9.B5f-4.1JqM");
  });

  describe("password_assignment", () => {
    it.each([
      ["env style", `password=${"s3cr3t-value"}`, "s3cr3t-value"],
      ["JSON style", `{"password": "${"s3cr3t-value"}"}`, "s3cr3t-value"],
      ["uppercase env", `SECRET=${"s3cr3t-value"}`, "s3cr3t-value"],
      ["yaml style", `passwd: ${"s3cr3t-value"}`, "s3cr3t-value"],
    ])("redacts %s", (_name, input, value) => {
      const result = redact(input);
      expect(result.text).toContain("[REDACTED:password_assignment]");
      expect(result.text).not.toContain(value);
      expect(result.hits[0]?.kind).toBe("password_assignment");
    });
  });

  it("redacts high-entropy base64 blobs", () => {
    expectSingleHit(
      `data: ${secrets.base64Blob}`,
      "base64_blob",
      secrets.base64Blob,
    );
  });

  it("reports hits in document order and keeps surrounding text", () => {
    const input = `a ${secrets.openai} b ${secrets.jwt} c`;
    const result = redact(input);
    expect(result.hits.map((hit) => hit.kind)).toEqual(["api_key", "jwt"]);
    expect(result.text).toBe(`a [REDACTED:api_key] b [REDACTED:jwt] c`);
  });

  it("treats a PEM body as one pem hit, not many base64 blobs", () => {
    const result = redact(secrets.pem);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.kind).toBe("pem");
  });

  it("is idempotent — redacting an already redacted text finds nothing", () => {
    const once = redact(`key ${secrets.openai} pass password=x1y2z3`);
    const twice = redact(once.text);
    expect(twice.hits).toHaveLength(0);
    expect(twice.text).toBe(once.text);
  });

  describe("false positives", () => {
    it("leaves git SHAs, UUIDs and sha256 digests untouched", () => {
      const sha = "a".charCodeAt(0);
      const gitSha = Array.from({ length: 40 }, (_, i) =>
        ((sha + i * 7) % 16).toString(16),
      ).join("");
      const sha256 = Array.from({ length: 64 }, (_, i) =>
        ((sha + i * 5) % 16).toString(16),
      ).join("");
      const uuid = "3f8a2b1c-4d5e-4f60-9a8b-7c6d5e4f3a2b";
      const input = `commit ${gitSha} digest ${sha256} id ${uuid}`;
      const result = redact(input);
      expect(result.hits).toHaveLength(0);
      expect(result.text).toBe(input);
    });

    it("leaves ordinary prose about secrets untouched", () => {
      const input = "The secret: Alice told Bob a story about passwords.";
      const result = redact(input);
      expect(result.hits).toHaveLength(0);
      expect(result.text).toBe(input);
    });
  });

  describe("shared corpus (TB-136)", () => {
    it("holds every AC-023 kind and every kind added by TB-136", () => {
      const kinds = new Set(corpus.cases.map((c) => c.kind));
      for (const kind of [
        "api_key",
        "jwt",
        "pem",
        "db_url",
        "base64",
        "nonstandard",
        "bearer",
        "tbk",
        "telegram",
        "stripe",
        "aws-session",
        "github",
        "slack",
        "assignment",
        "env",
        "url_credentials",
        "pgp",
      ]) {
        expect(kinds).toContain(kind);
      }
    });

    it.each(corpus.cases.map((c) => [c.id, c] as const))(
      "redacts %s and nothing else",
      (_id, c) => {
        const value = c.value.join("");
        const result = expectSingleHit(
          `${c.before}${value}${c.after}`,
          c.redact,
          value,
        );
        expect(redact(result.text).hits).toHaveLength(0);
      },
    );
  });

  describe("credential names in code stay readable (TB-136)", () => {
    it.each([
      ["a property", "apiKey: options.apiKey,"],
      ["a schema", "api_key: z.string(),"],
      ["a dotted name", "access_token = settings.accessToken"],
      ["an env reference", "GITHUB_TOKEN=$GITHUB_TOKEN"],
      ["a braced reference", `API_KEY="${"$"}{API_KEY}"`],
      ["a header reference", "x-api-key: $T_BOARDS_API_KEY"],
      ["a password reference", "password: $DB_PASSWORD"],
      ["joined words", "DEPLOY_TOKEN: replace_with_deploy_token"],
      ["a translated label", '"api_key": "APIキーを入力してください"'],
    ])("leaves %s untouched", (_name, input) => {
      const result = redact(input);
      expect(result.hits).toHaveLength(0);
      expect(result.text).toBe(input);
    });

    it("looksLikeSecret keeps a key and drops code-shaped values", () => {
      expect(looksLikeSecret(join("Zq8fK2mP", "9xL4vB7nR1tY"))).toBe(true);
      for (const value of [
        "short",
        "options.apiKey",
        "z.string()",
        "apiKeyValue",
        "your_secure_password",
        "パスワードを入力",
        "%s\\nX-GitHub",
      ]) {
        expect(looksLikeSecret(value)).toBe(false);
      }
    });
  });

  describe("base64 runs that are not key material (TB-136)", () => {
    const ids = [
      join("Ab3dE5fG7h", "J9kL1mN3pQ5r"),
      join("St7uV9wX1y", "Z3aB5cD7eF9g"),
      join("Hj2kL4mN6p", "Q8rS0tU2vW4x"),
    ];

    it("still redacts the same ids joined without path words", () => {
      const run = ids.join("/");
      expectSingleHit(`id ${run} end`, "base64_blob", run);
    });

    it.each([
      [
        "a PascalCase name",
        "import { Route as LayoutAuthenticatedWorkspaceSlugTaskTicketIdChar123TitleChar125RouteImport }",
      ],
      ["a data: URI", `src="data:image/png;base64,${secrets.base64Blob}"`],
      ["an SRI hash", `integrity="sha384-${secrets.base64Blob}"`],
      [
        "a URL path",
        `/dashboard/workspace/${ids[0]}/project/${ids[1]}/task/${ids[2]}`,
      ],
    ])("leaves %s untouched", (_name, input) => {
      expect(redact(input).hits).toHaveLength(0);
    });
  });

  // AC-023 known miss, pinned by this test: an unprefixed key under a name
  // with no credential word (openaiKey; api_key, *_TOKEN and x-api-key are
  // caught since TB-136) and plain alnum, so the base64-blob detector skips
  // it, is NOT redacted. Widening coverage here is a spec decision.
  it("known miss: unprefixed key in YAML is not redacted", () => {
    const unprefixed = "openaiKey: z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4";
    const result = redact(unprefixed);
    expect(result.hits).toHaveLength(0);
    expect(result.text).toBe(unprefixed);
  });

  it("handles empty input", () => {
    expect(redact("")).toEqual({ text: "", hits: [] });
  });

  // TB-136 security lens: an env name after a lowercase prefix is still a
  // credential name (the base rule caught app_CLIENT_SECRET=).
  it.each(["foo_API_KEY", "my_TOKEN", "app_CLIENT_SECRET", "db_PASSWORD"])(
    "redacts the value of %s= after a lowercase prefix",
    (name) => {
      const value = join("Qz8Lm4", "Rt7Wx2Ny5Kp9Bv3");
      expect(redact(`${name}=${value}`).text).toBe(
        `${name}=[REDACTED:password_assignment]`,
      );
    },
  );

  describe("pem without one lazy regex (TB-136)", () => {
    const begin = join("-----BEGIN ", "PRIVATE KEY-----");

    it("redacts two blocks as two hits and the text between them stays", () => {
      const result = redact(`${secrets.pem}\nnext\n${secrets.pem}`);
      expect(result.text).toBe("[REDACTED:pem]\nnext\n[REDACTED:pem]");
    });

    it("leaves a BEGIN line with no END line as is", () => {
      const lone = `${begin}\nMIIEvwIBADANBgkq`;
      expect(redact(lone).text).toBe(lone);
    });

    it("joins a broken BEGIN with the block after it, as the lazy regex did", () => {
      const result = redact(`${begin} cut\n${secrets.pem}`);
      expect(result.text).toBe("[REDACTED:pem]");
    });
  });

  // TB-136 security lens: a rule that may restart at every character and
  // scan to the end of the text is quadratic. MCP call arguments go through
  // redact before they are cut (api/src/mcp/call-detail.ts), so such a rule
  // holds the API event loop. On 256 000 characters each run takes up to
  // 26 ms linear and 1.3–60 s quadratic; the bound sits between them.
  it.each([
    "_",
    "A_",
    "a_",
    "a_A",
    "API_KEY",
    "TOKEN_",
    "a.",
    "a-",
    "a+",
    "eyJa.",
    "sk-",
    "Ab3+",
    "postgres://a:",
    "-----BEGIN KEY-----",
  ])("redacts 256 000 characters of %j in linear time", (unit) => {
    const text = unit.repeat(Math.ceil(256_000 / unit.length));
    const started = performance.now();
    redact(text);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
