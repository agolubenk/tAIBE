import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";

function renderBundle(bundle: string, key = "") {
  return execFileSync(
    "awk",
    ["-f", resolve(import.meta.dirname, "../env.awk")],
    {
      input: bundle,
      encoding: "utf8",
      env: {
        ...process.env,
        KANEO_TURNSTILE_SITE_KEY: key,
        KANEO_API_URL: "https://api.example.test",
        KANEO_CLIENT_URL: "https://app.example.test",
      },
    },
  );
}
describe("runtime environment replacement", () => {
  it("clears unset optional placeholders for every emitted literal quote", () => {
    const rendered = renderBundle(
      "globalThis.values = [\"KANEO_TURNSTILE_SITE_KEY\", 'KANEO_TURNSTILE_SITE_KEY', `KANEO_TURNSTILE_SITE_KEY`, 'https://example.test'];",
    );
    const context: { values?: string[] } = {};
    runInNewContext(rendered, context);
    expect(context.values).toEqual(["", "", "", "https://example.test"]);
  });
  it("encodes configured punctuation as literal data rather than JavaScript", () => {
    const key = '";globalThis.injected=true;//\\\n`';
    const context: { value?: string; injected?: boolean } = {};
    runInNewContext(
      renderBundle('globalThis.value = "KANEO_TURNSTILE_SITE_KEY";', key),
      context,
    );
    expect(context.value).toBe(key);
    expect(context.injected).toBeUndefined();
  });
});

describe("runtime environment and the asset cache", () => {
  it("lists rewritten assets for revalidation and keeps them across a restart", async () => {
    const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "kaneo-env-"));
    mkdirSync(join(root, "html", "assets"), { recursive: true });
    writeFileSync(
      join(root, "html", "assets", "auth-a1.js"),
      'a="KANEO_API_URL";',
    );
    writeFileSync(
      join(root, "html", "assets", "plain-b2.js"),
      "console.log(1);",
    );
    const include = join(root, "assets.inc");
    const cspInclude = join(root, "csp.inc");
    const run = () =>
      execFileSync("sh", [resolve(import.meta.dirname, "../env.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          KANEO_ASSET_ROOT: join(root, "html"),
          KANEO_ASSET_INCLUDE: include,
          KANEO_CSP_INCLUDE: cspInclude,
          KANEO_API_URL: "https://api.example.test",
          KANEO_CLIENT_URL: "https://app.example.test",
        },
      });

    run();
    expect(readFileSync(cspInclude, "utf8")).toContain(
      "add_header Content-Security-Policy-Report-Only ",
    );
    const expected = "location = /assets/auth-a1.js { expires epoch; }";
    expect(readFileSync(include, "utf8")).toContain(expected);
    expect(readFileSync(include, "utf8")).not.toContain("plain-b2.js");
    expect(
      readFileSync(join(root, "html", "assets", "auth-a1.js"), "utf8"),
    ).toBe('a="https://api.example.test";\n');

    // A restart finds nothing left to rewrite but keeps the earlier list, so
    // the chunk never becomes cacheable for a year while it holds env values.
    run();
    expect(readFileSync(include, "utf8")).toContain(expected);
  });
});

// OPS-65: the Content-Security-Policy header that env.sh writes for nginx.
function renderCsp(env: Record<string, string>) {
  const output = execFileSync(
    "awk",
    ["-v", "mode=csp", "-f", resolve(import.meta.dirname, "../env.awk")],
    {
      input: "",
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...env },
    },
  );
  const line = output.split("\n").find((row) => row.startsWith("add_header"));
  const match = line?.match(
    /^add_header Content-Security-Policy-Report-Only "([^"]*)" always;$/,
  );
  if (!match) throw new Error(`unexpected nginx line: ${output}`);
  return Object.fromEntries(
    match[1].split("; ").map((directive) => {
      const [name, ...sources] = directive.split(" ");
      return [name, sources];
    }),
  ) as Record<string, string[]>;
}

describe("Content-Security-Policy (OPS-65)", () => {
  it("loads images only from this origin and the sign-in avatar hosts", () => {
    const policy = renderCsp({});
    expect(policy["img-src"]).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https://avatars.githubusercontent.com",
      "https://*.googleusercontent.com",
      "https://cdn.discordapp.com",
      "https://secure.gravatar.com",
      "https://gitlab.com",
    ]);
    expect(policy["script-src"]).toEqual([
      "'self'",
      "https://challenges.cloudflare.com",
    ]);
    expect(policy["object-src"]).toEqual(["'none'"]);
    expect(policy["frame-ancestors"]).toEqual(["'none'"]);
    expect(policy["connect-src"]).toEqual(["'self'"]);
  });

  it("lets the API, its socket and the S3 upload origin connect", () => {
    const policy = renderCsp({
      KANEO_API_URL: "https://api.example.test/api",
      S3_ENDPOINT: "http://s3.example.test:9000",
    });
    expect(policy["connect-src"]).toEqual([
      "'self'",
      "https://api.example.test",
      "wss://api.example.test",
      "http://s3.example.test:9000",
    ]);
  });

  it("writes only validated origins into the nginx line", () => {
    for (const hostile of [
      "https://user:secret@s3.example.test",
      'https://s3.example.test" always; add_header X-Injected 1; #',
      "https://s3.example.test$host",
      "https://s3 example.test",
      "javascript:alert(1)",
      "s3.example.test",
    ]) {
      const policy = renderCsp({ S3_ENDPOINT: hostile });
      expect(policy["connect-src"], hostile).toEqual(["'self'"]);
    }
    // A path after a valid origin is dropped, not copied.
    const policy = renderCsp({
      KANEO_API_URL: 'https://api.example.test/"; add_header X 1; #',
    });
    expect(policy["connect-src"]).toEqual([
      "'self'",
      "https://api.example.test",
      "wss://api.example.test",
    ]);
  });

  it("finds no inline script in index.html, so script-src stays 'self'", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(
      resolve(import.meta.dirname, "../index.html"),
      "utf8",
    );
    const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter(
      ([, attributes]) => !/\bsrc=/.test(attributes),
    );
    expect(inline).toEqual([]);
  });
});
