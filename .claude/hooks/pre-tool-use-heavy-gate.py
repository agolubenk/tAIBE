#!/usr/bin/env python3
"""
PreToolUse (Bash) — тяжёлый гейт мимо общего замка: блок с готовой командой (HRH-124; зеркало tAIBE — SE-116).

Правило «один тяжёлый гейт на Mac за раз» держит обёртка `.claude/scripts/heavy-gate.sh` (замок на машину). Этот хук
останавливает tsc, vitest, jest, сборки vite/nest/next, playwright test, `turbo`/`npm`/`pnpm`/`vp`
typecheck|test|build|lint|ci (доски tAIBE — pnpm и vite-plus: `pnpm typecheck`, `vp check`) и `docker build`,
запущенные без неё. `pnpm install`/`exec`/`i18n:check` — не гейт. Команды разбираются по argv (merge_guard_shell): слово «vitest» в тексте коммита,
сообщения Нерва или `grep` — не гейт; обёрнута команда, чьё первое слово — `heavy-gate.sh`. `npm ci` — установка, не
гейт (скрипт CI — `npm run ci`). Скрипт с гейтами внутри (`bash gate.sh`, `make test`) хук не видит — его запускают
через обёртку целиком. Обход — `HEAVY_GATE_CHECK=0` в команде или в окружении claude. Блок и обход — строка в общий
журнал замка `~/.claude/locks/heavy-gate.log` (время, событие, имя команды, папка; без аргументов).
Fail-open: любой сбой самого хука — пропуск.
"""
import json
import os
import shlex
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

WRAPPER = Path(__file__).resolve().parents[1] / "scripts" / "heavy-gate.sh"
LOG = Path.home() / ".claude" / "locks" / "heavy-gate.log"  # общий с обёрткой
TOOLS = {"tsc", "vitest", "jest"}  # тяжёлые при любых аргументах (кроме справки и версии)
SUBCOMMAND = {"vite": {"build"}, "nest": {"build"}, "next": {"build"}, "playwright": {"test"}}
SCRIPTS = {"typecheck", "test", "test:run", "test:coverage", "test:e2e", "build", "build:packages", "build:bundle",
           "lint", "ci"}
RUNNERS = {"npx", "bunx"}  # `npx tsc` — дальше настоящая команда
LIGHT = {"--version", "-v", "--help", "-h"}
VALUE_FLAGS = {"-w", "--workspace", "--prefix", "-C", "-f", "--file", "-p", "--project-name", "--filter", "-F",
               "--dir"}
VP_DIRECT = {"check", "test", "build", "lint"}  # vite-plus без `run`: `vp check` — линт и типы досок
PKG_MANAGERS = {"pnpm", "npm", "yarn", "bun"}
PKG_EXEC = {"exec", "dlx", "x"}  # `pnpm exec tsc` — дальше настоящая команда


def positional(args):
    """Слова без флагов и их значений: `-w apps/backend test` → [test]; `--workspace=x` — один флаг."""
    out, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif a in VALUE_FLAGS:
            skip = True
        elif not a.startswith("-"):
            out.append(a)
    return out


def first_positional(args):
    """Индекс первого слова без флагов и их значений или None."""
    skip = False
    for i, a in enumerate(args):
        if skip:
            skip = False
        elif a in VALUE_FLAGS:
            skip = True
        elif not a.startswith("-"):
            return i
    return None


def unwrap(argv):
    """Настоящая команда за запускателями: `npx tsc`, `pnpm exec tsc`, `npm exec -- vitest`, `pnpm vitest run`
    (линза backend #338)."""
    while argv:
        if argv[0] in RUNNERS:
            argv = argv[1:]
        elif os.path.basename(argv[0]) in PKG_MANAGERS:
            i = first_positional(argv[1:])
            if i is None:
                return argv
            word = argv[1 + i]
            if word in PKG_EXEC:
                argv = argv[2 + i:]
            elif word in TOOLS:
                argv = argv[1 + i:]
                return argv
            else:
                return argv
        else:
            return argv
        while argv and argv[0].startswith("-"):
            argv = argv[1:]
    return argv


def heavy(argv):
    """Имя тяжёлой команды (`tsc`, `npm`…) или None: argv без префиксов (normalize), первое слово — без пути."""
    argv = unwrap(argv)
    if not argv or LIGHT & set(argv[1:]):
        return None
    name = os.path.basename(argv[0])
    return name if is_gate(name, positional(argv[1:])) else None


def is_gate(name, words):
    if name in TOOLS:
        return True
    if name in SUBCOMMAND:
        return words[:1] != [] and words[0] in SUBCOMMAND[name]
    if name == "turbo":
        words = words[1:] if words[:1] == ["run"] else words
        return words[:1] != [] and words[0] in SCRIPTS
    if name == "npm":
        if words[:1] in (["run"], ["run-script"]):
            return words[1:2] != [] and words[1] in SCRIPTS
        return words[:1] in (["test"], ["t"])
    if name == "pnpm":  # `pnpm typecheck`, `pnpm run test`, `pnpm --dir boards --filter ./apps/api run typecheck`
        if words[:1] in (["run"], ["run-script"]):
            return words[1:2] != [] and words[1] in SCRIPTS
        return words[:1] != [] and (words[0] in SCRIPTS or words[0] == "t")
    if name == "vp":  # `vp run -r typecheck`, `vp check`, `vp test`
        if words[:1] == ["run"]:
            return words[1:2] != [] and words[1] in SCRIPTS
        return words[:1] != [] and words[0] in VP_DIRECT
    if name == "docker":
        return words[:1] == ["build"] or words[:1] in (["compose"], ["buildx"]) and "build" in words
    return False


def log(event, name, cwd):
    """Строка в журнал замка: время, событие, имя команды, папка. Сбой записи — молча."""
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} hook-{event} {name} {Path(cwd).name}\n")
    except OSError:
        pass


def main():
    if os.environ.get("HEAVY_GATE_HELD"):  # команда уже внутри обёртки
        return 0
    data = json.loads(sys.stdin.read() or "{}")
    orig = (data.get("tool_input") or {}).get("command") or ""
    if not orig:
        return 0
    from merge_guard_shell import cut_heredocs, normalize, split_commands, strip_comments, tokenize

    cmd, _bodies = cut_heredocs(orig)
    cmd = strip_comments(cmd).replace("\\\n", " ")
    name = None
    for argv, *_ in split_commands(tokenize(cmd)):
        a = normalize(argv)
        if a and a[0] != "heavy-gate.sh":  # `cat …/heavy-gate.sh; npx tsc` — tsc не обёрнут
            name = name or heavy(a)
    if not name:
        return 0
    cwd = data.get("cwd") or os.getcwd()
    if os.environ.get("HEAVY_GATE_CHECK") == "0" or "HEAVY_GATE_CHECK=0" in orig:
        log("bypass", name, cwd)
        return 0
    log("block", name, cwd)
    ready = f"{WRAPPER} bash -c {shlex.quote(orig)}" if len(orig) <= 400 and "\n" not in orig else \
        f"{WRAPPER} bash -c '<команда>'"
    print(f"Тяжёлый гейт — через общий замок, один на Mac (HRH-124):\n{ready}\n"
          "Замок занят — обёртка ждёт: длинный гейт запускай с run_in_background или большим timeout.\n"
          "Не гейт (лёгкая команда) — добавь HEAVY_GATE_CHECK=0 в начало команды.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # fail-open: сбой хука не останавливает работу
        sys.exit(0)
