import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HTTPException } from "hono/http-exception";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  decryptSecret,
  encryptSecret,
} from "../../apps/api/src/notification-preferences/secrets";

const KEY = "NOTIFICATION_SECRET_ENCRYPTION_KEY";
const KEY_FILE = `${KEY}_FILE`;
const SECRET_KEY = "file-key-0123456789abcdef0123456789";

function noKey(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPException);
    expect((error as HTTPException).message).toContain(KEY_FILE);
    return;
  }
  throw new Error("expected the key to be missing");
}

// TB-19 (N-007): the notification key can live in a file, like the other
// server secrets; a file that is not there leaves the channels off.
describe("notification secret key from a file", () => {
  const saved: Record<string, string | undefined> = {};
  let directory: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "tb19-key-"));
    for (const name of [KEY, KEY_FILE]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    warn.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  });

  function keyFile(name: string, content: string) {
    const file = path.join(directory, name);
    writeFileSync(file, content, { mode: 0o400 });
    return file;
  }

  it("seals with the key from the file and opens with the same key from env", () => {
    process.env[KEY_FILE] = keyFile("key", `${SECRET_KEY}\n`);
    const sealed = encryptSecret("ntfy-token");
    expect(sealed).toMatch(/^enc:v1:/);
    expect(decryptSecret(sealed)).toBe("ntfy-token");

    delete process.env[KEY_FILE];
    process.env[KEY] = SECRET_KEY;
    expect(decryptSecret(sealed)).toBe("ntfy-token");
    expect(warn).not.toHaveBeenCalled();
  });

  it("prefers the env value over the file, as other secrets do", () => {
    process.env[KEY] = SECRET_KEY;
    process.env[KEY_FILE] = path.join(directory, "missing");
    expect(decryptSecret(encryptSecret("gotify-token"))).toBe("gotify-token");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a missing file as no key and logs the reason once, not the key", () => {
    const missing = path.join(directory, "missing");
    process.env[KEY_FILE] = missing;

    noKey(() => encryptSecret("webhook-secret"));
    noKey(() => encryptSecret("webhook-secret"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(missing);
    expect(String(warn.mock.calls[0]?.[0])).toContain("ENOENT");
  });

  it("treats an empty file as no key", () => {
    process.env[KEY_FILE] = keyFile("empty", "");
    noKey(() => encryptSecret("webhook-secret"));
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("empty file");
  });

  it("has no key when neither the variable nor the file is set", () => {
    noKey(() => encryptSecret("webhook-secret"));
    expect(encryptSecret(null)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs no key value", () => {
    process.env[KEY_FILE] = keyFile("good", SECRET_KEY);
    encryptSecret("x");
    process.env[KEY_FILE] = keyFile("blank", "");
    noKey(() => encryptSecret("x"));
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain(SECRET_KEY);
    }
  });
});
