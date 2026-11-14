// TB-145: scripts/it-pg.sh with docker, lsof and npx replaced by stubs in PATH.
// Run: node --test scripts/it-pg.test.mjs (from boards/).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "it-pg.sh");

// The stubs log every call to $STUB/log; $STUB/running marks a live container.
const STUBS = {
  docker: `#!/usr/bin/env bash
echo "docker $*" >> "$STUB/log"
case "$1" in
ps)
  case "$*" in
  *name=*) [ -z "\${STUB_EXISTS:-}" ] || echo other1 ;;
  *label=*) [ ! -f "$STUB/running" ] || echo cid1 ;;
  esac ;;
run)
  for arg in "$@"; do case "$arg" in 127.0.0.1:*:5432) echo "\${arg%:5432}" > "$STUB/port" ;; esac; done
  touch "$STUB/running"
  echo cid1 ;;
port) if [ -n "\${STUB_PORT_OUT:-}" ]; then echo "$STUB_PORT_OUT"; else cat "$STUB/port"; fi ;;
exec) exit 0 ;;
rm) rm -f "$STUB/running" ;;
esac
`,
  lsof: `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in -iTCP:*) port="\${arg#-iTCP:}" ;; esac
done
case ",\${STUB_TAKEN:-}," in *",$port,"*) exit 0 ;; esac
exit 1
`,
  npx: `#!/usr/bin/env bash
echo "npx $* DATABASE_URL=$DATABASE_URL" >> "$STUB/log"
[ -z "\${STUB_TEST_SLEEP:-}" ] || exec sleep "$STUB_TEST_SLEEP"
exit "\${STUB_TEST_EXIT:-0}"
`,
};

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "it-pg-"));
  for (const [name, body] of Object.entries(STUBS)) {
    const file = join(dir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(
  args,
  env = {},
  { interruptAfter, signal = "SIGINT", group = true } = {},
) {
  return new Promise((resolve) => {
    const child = spawn("bash", [script, ...args], {
      env: {
        ...process.env,
        IT_PG_PORT: "",
        ...env,
        PATH: `${dir}:${process.env.PATH}`,
        STUB: dir,
      },
      // Its own process group: Ctrl-C reaches the script and the test run.
      detached: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (interruptAfter) {
      setTimeout(
        () => process.kill(group ? -child.pid : child.pid, signal),
        interruptAfter,
      );
    }
    child.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

const log = () =>
  existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8") : "";
const running = () => existsSync(join(dir, "running"));

test("a green run passes the arguments, uses its own port and removes the container", async () => {
  const res = await run(["tb145", "a.test.ts"]);

  assert.equal(res.code, 0, res.stderr);
  assert.match(
    log(),
    /npx vp test run --config vitest.integration.config.ts a.test.ts DATABASE_URL=postgresql:\/\/kaneo:[0-9a-f]{24}@127\.0\.0\.1:55400\/kaneo_test/,
  );
  assert.match(
    log(),
    /docker run -d --rm --name tb145-it-pg --label it-pg\.run=[0-9a-f]{16} /,
  );
  assert.match(log(), /docker rm -f cid1/);
  assert.equal(running(), false);
});

test("a red run keeps the test exit code and removes the container", async () => {
  const res = await run(["tb145"], { STUB_TEST_EXIT: "1" });

  assert.equal(res.code, 1);
  assert.match(log(), /docker rm -f cid1/);
  assert.equal(running(), false);
});

test("Ctrl-C during the run removes the container", async () => {
  const res = await run(
    ["tb145"],
    { STUB_TEST_SLEEP: "5" },
    { interruptAfter: 800 },
  );

  assert.ok(
    res.code === 130 || res.signal === "SIGINT",
    `${res.code} ${res.signal}`,
  );
  assert.match(log(), /docker rm -f cid1/);
  assert.equal(running(), false);
});

test("TERM to the script alone stops the test run at once and removes the container", async () => {
  const started = Date.now();
  const res = await run(
    ["tb145"],
    { STUB_TEST_SLEEP: "20" },
    { interruptAfter: 800, signal: "SIGTERM", group: false },
  );

  assert.equal(res.code, 143, res.stderr);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  assert.match(log(), /docker rm -f cid1/);
  assert.equal(running(), false);
});

test("a taken port is refused before any container or test", async () => {
  const res = await run(["tb145"], {
    IT_PG_PORT: "55410",
    STUB_TAKEN: "55410",
  });

  assert.equal(res.code, 3);
  assert.match(res.stderr, /port 55410 is taken/);
  assert.doesNotMatch(log(), /docker run|npx/);
});

test("the free port search skips taken ports", async () => {
  const res = await run(["tb145"], { STUB_TAKEN: "55400,55401" });

  assert.equal(res.code, 0, res.stderr);
  assert.match(log(), /@127\.0\.0\.1:55402\/kaneo_test/);
});

test("the ports of the live databases are refused", async () => {
  for (const port of ["5432", "5433"]) {
    const res = await run(["tb145"], { IT_PG_PORT: port });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /belongs to a live database/);
  }
  assert.doesNotMatch(log(), /docker run|npx/);
});

test("a container published on another address stops the run before the tests", async () => {
  const res = await run(["tb145"], { STUB_PORT_OUT: "0.0.0.0:55400" });

  assert.equal(res.code, 3);
  assert.match(res.stderr, /not 127\.0\.0\.1:55400/);
  assert.doesNotMatch(log(), /npx/);
  assert.equal(running(), false);
});

test("an existing container of the same name is left alone", async () => {
  const res = await run(["tb145"], { STUB_EXISTS: "1" });

  assert.equal(res.code, 3);
  assert.match(res.stderr, /tb145-it-pg already exists/);
  assert.doesNotMatch(log(), /docker run|docker rm|npx/);
});

test("a name outside a-z, 0-9, «.», «_», «-» is refused", async () => {
  const res = await run(["../x"]);

  assert.equal(res.code, 2);
  assert.equal(log(), "");
});

test("tools/run-int.sh is retired: it stops before any database and points to it-pg.sh", () => {
  const runInt = join(dirname(script), "..", "tools", "run-int.sh");
  const res = spawnSync("zsh", [runInt, "health"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB: dir },
  });

  assert.equal(res.status, 2);
  assert.match(res.stderr, /scripts\/it-pg\.sh <name>/);
  assert.equal(log(), "");
});
