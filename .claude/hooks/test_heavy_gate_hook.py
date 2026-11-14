#!/usr/bin/env python3
"""Проверка хука pre-tool-use-heavy-gate.py (HRH-124): какие команды Bash он останавливает; и что Stop-хук typecheck
при занятом замке пропускает проверку, а не запускает второй tsc.

Запуск: python3 -I .claude/hooks/test_heavy_gate_hook.py  (exit 1 при расхождении).
Хук запускается целиком, как его зовёт Claude Code: JSON на stdin, код 2 — блок, 0 — пропуск. HOME — временный:
журнал замка пишется туда, а не в настоящий ~/.claude/locks.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOOK = HERE / "pre-tool-use-heavy-gate.py"
HOME = tempfile.mkdtemp()
LOG = Path(HOME) / ".claude" / "locks" / "heavy-gate.log"

BLOCK = [
    "npx tsc --noEmit -p apps/backend/tsconfig.json",
    "cd apps/backend && npx vitest run src/x.spec.ts",
    "cd apps/backend && WT_DEPS_CHECK=0 ~/Desktop/Development/HR_Helper-v2/node_modules/.bin/vitest run a.spec.ts",
    "turbo run typecheck --filter=@hr-helper/nestjs-api-v2",
    "npx turbo run test:run --filter=frontend",
    "npm run build",
    "npm run -w apps/backend test:run",
    "cd boards && pnpm typecheck",
    "pnpm --dir boards --filter ./apps/api run typecheck",
    "pnpm -C boards test",
    "cd boards/apps/web && pnpm run build",
    "vp run -r typecheck",
    "cd boards && vp check",
    "npm --workspace=apps/frontend run typecheck",
    "npm test",
    "npm run ci",
    "npx vite build",
    "npx playwright test e2e/login.spec.ts",
    "docker compose -f infra/docker/docker-compose.yml build backend",
    "docker build -t x .",
    "git status && npx tsc --noEmit",
    "NODE_OPTIONS=--max-old-space-size=6144 npm run build:bundle",
    "cat .claude/scripts/heavy-gate.sh; npx tsc --noEmit",
]
PASS = [
    "git commit -m 'fix: vitest и tsc зелёные'",
    'python3 -I eval/nerve/nerve.py emit coord "gate pass: be tsc, vitest 6/6"',
    "grep -rn vitest package.json",
    "gh pr create --body \"$(cat <<'EOF'\nnpx tsc прошёл\nnpm run build\nEOF\n)\"",
    "npx tsc --version",
    "npm run done:index",
    "npm install",
    "npm ci",
    "npm run lint:fix",
    "docker compose up -d backend",
    ".claude/scripts/heavy-gate.sh npx tsc --noEmit",
    "HEAVY_GATE_CHECK=0 npx vitest run x",
    "ls apps/backend  # потом npx tsc",
    "cat 'unbalanced",
    "pnpm install --frozen-lockfile",
    "pnpm --dir boards i18n:check",
    "pnpm exec tsc --version",
    "vp --version",
]


def run(cmd, env=None):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    e = {k: v for k, v in os.environ.items() if not k.startswith("HEAVY_GATE_")}
    e.update(env or {}, HOME=HOME)
    p = subprocess.run([sys.executable, "-I", str(HOOK)], input=payload, capture_output=True, text=True, env=e)
    return p.returncode, p.stderr


def log_has(fragment):
    return LOG.exists() and fragment in LOG.read_text(encoding="utf-8")


def stop_hook_skips_when_busy():
    """Замок держит живой процесс — Stop-хук возвращает «skipped» за секунды и сам typecheck не запускает."""
    spec = importlib.util.spec_from_file_location("stop_typecheck_gate", HERE / "stop-typecheck-gate.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    lock = Path(HOME) / "lock"
    holder = subprocess.Popen(["sleep", "30"])
    try:
        start = subprocess.run(["ps", "-o", "lstart=", "-p", str(holder.pid)], capture_output=True, text=True,
                               env=dict(os.environ, LC_ALL="C")).stdout.strip()
        lock.mkdir()
        (lock / "owner").write_text(f"{holder.pid}\n{start}\n{int(time.time())}\nчужой\nsleep\n")
        os.environ["HEAVY_GATE_LOCK"] = str(lock)
        t = time.monotonic()
        hint = mod.typecheck({"apps/x"}, Path(HOME))
        return (hint or "").startswith("Typecheck skipped for apps/x") and time.monotonic() - t < 10
    finally:
        os.environ.pop("HEAVY_GATE_LOCK", None)
        holder.kill()
        holder.wait()


def main():
    bad = 0
    for cmd in BLOCK:
        rc, err = run(cmd)
        if rc != 2 or "heavy-gate.sh" not in err:
            print(f"not ok - должен остановить: {cmd!r} (код {rc})")
            bad += 1
    for cmd in PASS:
        rc, err = run(cmd)
        if rc != 0:
            print(f"not ok - должен пропустить: {cmd!r} (код {rc}: {err[:120]})")
            bad += 1
    for env in ({"HEAVY_GATE_CHECK": "0"}, {"HEAVY_GATE_HELD": "/tmp/x"}):
        rc, _ = run("npx tsc --noEmit", env)
        if rc != 0:
            print(f"not ok - обход окружением {env} не сработал")
            bad += 1
    rc, err = run("cd apps/backend && npx tsc --noEmit")
    if "heavy-gate.sh bash -c 'cd apps/backend && npx tsc --noEmit'" not in err:
        print(f"not ok - готовая команда должна сохранить cd: {err[:200]}")
        bad += 1
    p = subprocess.run([sys.executable, "-I", str(HOOK)], input="не json", capture_output=True, text=True)
    if p.returncode != 0:
        print("not ok - сбой разбора входа должен пропускать (fail-open)")
        bad += 1
    LOG.unlink(missing_ok=True)
    run("npx tsc --noEmit")
    run("HEAVY_GATE_CHECK=0 npx vitest run x")
    run("git status")
    lines = LOG.read_text(encoding="utf-8").splitlines() if LOG.exists() else []
    if not (log_has(" hook-block tsc ") and log_has(" hook-bypass vitest ") and len(lines) == 2):
        print(f"not ok - журнал: блок и обход по строке, лёгкая команда — без строки: {lines}")
        bad += 1
    if log_has("--noEmit") or log_has(" run x"):
        print("not ok - в журнале не должно быть аргументов команды")
        bad += 1
    if not stop_hook_skips_when_busy():
        print("not ok - Stop-хук typecheck при занятом замке должен пропустить проверку")
        bad += 1
    total = len(BLOCK) + len(PASS) + 7
    print(f"{total - bad}/{total} ok")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
