#!/usr/bin/env python3
"""spawn_session.sh: a successor starts as a top-level session — inherited child-session markers are dropped
before `claude` runs, so its transcript is saved (hooks, eval measurements and claude-mem read it); every
descendant gets its own lineage id under its parent's.

Run: python3 -I eval/tools/test_spawn_session.py   (exit 1 on mismatch; --dry-run only, nothing is launched)
"""
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "spawn_session.sh"


def dry_run(env_extra):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("продолжай по handoff\n", encoding="utf-8")
        env = {**os.environ, **env_extra, "TMPDIR": tmp}
        return subprocess.run(["bash", str(SCRIPT), "--handoff", str(handoff), "--dry-run", "--cwd", tmp],
                              capture_output=True, text=True, env=env, timeout=30)


failed = 0
# CLAUDE_BIN reaches the launcher (a Terminal window starts with a clean environment); unset -> no export line.
for env_extra, want in [({"CLAUDE_BIN": "/opt/x y/claude-nongene"}, "export CLAUDE_BIN='/opt/x y/claude-nongene'"),
                        ({"CLAUDE_BIN": ""}, None)]:
    got = [ln for ln in dry_run(env_extra).stdout.splitlines() if ln.startswith("export CLAUDE_BIN=")]
    if got != ([want] if want else []):
        failed += 1
        print("FAIL: CLAUDE_BIN in launcher", env_extra, "->", got)
proc = dry_run({"CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDECODE": "1", "TAIBE_LINEAGE": "r.ab12"})
lines = proc.stdout.splitlines()
unset_at = next((i for i, ln in enumerate(lines) if ln.startswith("unset ") and "CLAUDE_CODE_CHILD_SESSION" in ln), None)
# Terminal: claude без exec (окно закроется само после выхода), иначе exec; в обоих случаях — после unset.
exec_at = next((i for i, ln in enumerate(lines) if ln.startswith(("exec ", '"${CLAUDE_BIN:-claude}"'))), None)
for name, ok in [
    ("dry-run succeeds", proc.returncode == 0),
    ("launcher unsets CLAUDE_CODE_CHILD_SESSION and CLAUDECODE",
     unset_at is not None and "CLAUDECODE" in lines[unset_at]),
    ("unset comes before claude starts", unset_at is not None and exec_at is not None and unset_at < exec_at),
    ("Terminal: claude in its own group, window closes only after exit 0",
     "set -m" in lines and any(ln.startswith('[ "$rc" = 0 ] ||') for ln in lines)
     and any(" autoclose --tty " in ln for ln in lines) and lines[-1:] != [] and "exit 0" in lines),
    ("descendant gets its own lineage under the parent's",
     any(re.fullmatch(r"export TAIBE_LINEAGE='r\.ab12\.[a-z0-9]{4}'", ln) for ln in lines)),
    ("first message names the lineage and generation 2", re.search(r"Линия: r\.ab12\.[a-z0-9]{4} \(поколение 2\)", proc.stdout)
     is not None),
]:
    if not ok:
        failed += 1
        print("FAIL:", name)
        print(proc.stdout, proc.stderr, sep="\n")

# OPS-24: --launch в пустом каталоге сессий открывает роли по порядку и печатает итог; --status — «нет» у каждой роли.
with tempfile.TemporaryDirectory() as tmp:
    env = {**os.environ, "TMPDIR": tmp, "CLAUDE_SESSIONS_DIR": os.path.join(tmp, "sess"),
           "TAIBE_LINEAGE_DIR": os.path.join(tmp, "lin"), "NERVE_PLIST": os.path.join(tmp, "none.plist")}
    launch = subprocess.run(["bash", str(SCRIPT), "--launch", "--roles", "plan,coord", "--dry-run", "--cwd", tmp],
                            capture_output=True, text=True, env=env, timeout=60)
    status = subprocess.run(["bash", str(SCRIPT), "--status", "--cwd", tmp], capture_output=True, text=True, env=env,
                            timeout=60)
out = launch.stdout
for name, ok in [
    ("launch dry-run succeeds", launch.returncode == 0),
    ("nerve is checked before roles", out.find("нерв:") != -1 and out.find("нерв:") < out.find("# plan: вставить")),
    ("roles open in the given order", -1 < out.find("# plan: вставить") < out.find("# coord: вставить")),
    ("summary lists every role", "итог (" in out and "plan — команда напечатана" in out
     and "coord — команда напечатана" in out),
    ("status: every role of ORDER, none alive", status.returncode == 0
     and all(f"{n} {r:<9} нет" in status.stdout for n, r in
             [(1, "coord"), (5, "release"), (4, "backend"), (3, "frontend"), (2, "plan"), (6, "boards")])),
]:
    if not ok:
        failed += 1
        print("FAIL:", name)
        print(launch.stdout, launch.stderr, status.stdout, status.stderr, sep="\n")

# OPS-24, линза 7b: проверка живой роли сломалась (копия без lineage_reap.py → трейсбек импорта, rc 1) — роль НЕ
# открывается: вторая сессия живой роли хуже пропуска. Открывает только явный ответ «роли нет».
with tempfile.TemporaryDirectory() as tmp:
    tools = Path(tmp) / "layer" / "tools"
    tools.mkdir(parents=True)
    for f in ("spawn_session.sh", "team_status.py", "lineage.py"):
        (tools / f).write_bytes((SCRIPT.parent / f).read_bytes())
    (tools.parent / "pipeline").mkdir()
    (tools.parent / "pipeline" / "genome").symlink_to(SCRIPT.parent.parent / "pipeline" / "genome")
    env = {**os.environ, "TMPDIR": tmp, "CLAUDE_SESSIONS_DIR": os.path.join(tmp, "sess"),
           "TAIBE_LINEAGE_DIR": os.path.join(tmp, "lin"), "NERVE_PLIST": os.path.join(tmp, "none.plist")}
    prompts = str(SCRIPT.parent.parent / "prompts" / "launch-3010" / "roles")
    broken = subprocess.run(["bash", str(tools / "spawn_session.sh"), "--launch", "--role", "coord", "--dry-run",
                             "--prompt-dir", prompts, "--cwd", tmp], capture_output=True, text=True, env=env, timeout=60)
    typo = subprocess.run(["bash", str(SCRIPT), "--launch", "--roles", "plan,cord", "--dry-run", "--cwd", tmp],
                          capture_output=True, text=True, env=env, timeout=60)
for name, ok in [
    ("broken check: role not opened", broken.returncode == 0 and "# coord: вставить" not in broken.stdout),
    ("broken check: summary says not opened", "coord — НЕ открыта: проверка не прошла" in broken.stdout),
    ("role list checked before anything opens", typo.returncode != 0 and "# plan: вставить" not in typo.stdout
     and "неизвестная роль: cord" in typo.stderr),
]:
    if not ok:
        failed += 1
        print("FAIL:", name)
        print(broken.stdout, broken.stderr, typo.stdout, typo.stderr, sep="\n")

# 06.11: окно Terminal закрывается само; печать команды (--terminal print) и --keep-window — прежний exec без autoclose.
def launcher_lines(*flags):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("x\n", encoding="utf-8")
        run = subprocess.run(["bash", str(SCRIPT), "--handoff", str(handoff), "--dry-run", "--cwd", tmp, *flags],
                             capture_output=True, text=True, env={**os.environ, "TMPDIR": tmp}, timeout=30)
        return run.returncode, run.stdout.splitlines()


for name, flags in [("print", ["--terminal", "print"]), ("keep-window", ["--keep-window"])]:
    rc, out = launcher_lines(*flags)
    ok = rc == 0 and any(ln.startswith("exec ") for ln in out) and not any("autoclose" in ln for ln in out)
    if not ok:
        failed += 1
        print("FAIL: %s keeps exec and no autoclose" % name)
        print("\n".join(out))

# OPS-25: продукт — --product, иначе TAIBE_PRODUCT из env (наследник берёт продукт предшественника), иначе по умолчанию.
def product_run(env_extra, *flags):
    with tempfile.TemporaryDirectory() as tmp:
        handoff = Path(tmp) / "handoff.md"
        handoff.write_text("x\n", encoding="utf-8")
        env = {**os.environ, "TMPDIR": tmp, **env_extra}
        run = subprocess.run(["bash", str(SCRIPT), "--handoff", str(handoff), "--role", "boards", "--dry-run",
                              "--cwd", tmp, *flags], capture_output=True, text=True, env=env, timeout=30)
        return run.returncode, run.stdout + run.stderr


for name, env_extra, flags, genome, product in [
    ("successor of a tAIBE role gets the tAIBE genome", {"TAIBE_PRODUCT": "taibe"}, [], "/genome/taibe/boards.json", "taibe"),
    ("--product equal to the inherited product", {"TAIBE_PRODUCT": "taibe"}, ["--product", "taibe"],
     "/genome/taibe/boards.json", "taibe"),
    ("no product — the default product", {"TAIBE_PRODUCT": ""}, [], "/genome/boards.json", "hr-helper"),
]:
    rc, out = product_run(env_extra, *flags)
    ok = rc == 0 and genome in out and f"export TAIBE_PRODUCT='{product}'" in out
    if not ok:
        failed += 1
        print("FAIL:", name)
        print(out)
# Наследник другого продукта через --handoff снял бы живую роль чужого продукта: отказ с подсказкой --launch.
rc, out = product_run({"TAIBE_PRODUCT": ""}, "--product", "taibe")
if rc == 0 or "--launch --product taibe" not in out:
    failed += 1
    print("FAIL: --handoff into another product is refused")
    print(out)
rc, out = product_run({}, "--product", "nope")
if rc == 0 or "нет продукта nope" not in out:
    failed += 1
    print("FAIL: unknown product is refused")
    print(out)

# SE-93: окно открыто, только если пусковой скрипт стартовал — он удаляет свою папку. Terminal вернул -1712, окна не
# было, а скрипт писал «открыто», записывал линию и запускал сторожа retire без наследника. Подмены в копии слоя:
# osascript (FAKE_RC — код, FAKE_START=1 — «окно открылось»: папка скрипта удаляется), lineage.py и team_status.py
# пишут в журнал свой подкоманду — настоящий нерв и launchd не трогаются.
FAKE_OSA = r"""#!/bin/bash
echo osascript >>"$FAKE_LOG"
l="$(printf '%s' "$*" | sed -n "s|.*/bin/bash '\([^']*\)'.*|\1|p")"
if [ "${FAKE_START:-0}" = 1 ] && [ -n "$l" ]; then rm -rf "$(dirname "$l")"; fi
if [ "${FAKE_RC:-0}" = 0 ]; then echo "123 /dev/ttys009"; exit 0; fi
echo "execution error: Terminal got an error: AppleEvent timed out. (-1712)" >&2
exit "$FAKE_RC"
"""
FAKE_PY = """import os, sys
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(sys.argv[1] + "\\n")
if sys.argv[1] == "wait":
    sys.exit(1)
print("нерв: подмена")
"""


def osa_run(terminal, rc, start, launch=False):
    with tempfile.TemporaryDirectory() as tmp:
        tools = Path(tmp) / "layer" / "tools"
        tools.mkdir(parents=True)
        (tools / "spawn_session.sh").write_bytes(SCRIPT.read_bytes())
        for f in ("lineage.py", "team_status.py"):
            (tools / f).write_text(FAKE_PY, encoding="utf-8")
        (tools.parent / "pipeline").mkdir()
        (tools.parent / "pipeline" / "genome").symlink_to(SCRIPT.parent.parent / "pipeline" / "genome")
        fake_bin = Path(tmp) / "bin"
        fake_bin.mkdir()
        (fake_bin / "osascript").write_text(FAKE_OSA, encoding="utf-8")
        (fake_bin / "osascript").chmod(0o755)
        handoff = Path(tmp) / "h.md"
        handoff.write_text("x\n", encoding="utf-8")
        log = Path(tmp) / "fake.log"
        env = {**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}", "TMPDIR": tmp, "TAIBE_LINEAGE": "r.ab12",
               "FAKE_RC": str(rc), "FAKE_START": "1" if start else "0", "FAKE_LOG": str(log), "SPAWN_START_WAIT": "1"}
        if launch:
            args = ["--launch", "--roles", "plan,coord", "--force", "--prompt-dir",
                    str(SCRIPT.parent.parent / "prompts" / "launch-3010" / "roles")]
        else:
            args = ["--handoff", str(handoff)]
        run = subprocess.run(["bash", str(tools / "spawn_session.sh"), *args, "--terminal", terminal, "--cwd", tmp],
                             capture_output=True, text=True, env=env, timeout=60)
        calls = log.read_text(encoding="utf-8").split() if log.exists() else []
        return run.returncode, run.stdout + run.stderr, calls, list(Path(tmp).glob("claude-spawn.*"))


for terminal in ("terminal", "iterm"):
    rc, out, calls, left = osa_run(terminal, 1, start=False)
    for name, ok in [
        (f"{terminal}: osascript error -> code 4", rc == 4),
        (f"{terminal}: no «открыто», hint --terminal print", "открыто:" not in out and "--terminal print" in out),
        (f"{terminal}: no lineage record, no retire guard", "record" not in calls and "retire" not in calls),
        (f"{terminal}: launcher folder removed — a late window starts nothing", left == []),
    ]:
        if not ok:
            failed += 1
            print("FAIL:", name, rc, calls, left)
            print(out)
    rc, out, calls, _ = osa_run(terminal, 0, start=True)
    if not (rc == 0 and "открыто:" in out and calls.count("record") == 1 and "retire" in calls):
        failed += 1
        print(f"FAIL: {terminal}: window opened -> record, «открыто», retire", rc, calls)
        print(out)
rc, out, calls, _ = osa_run("terminal", 1, start=True)  # -1712 пришёл, но окно всё же открылось
if not (rc == 0 and "открыто:" in out and "record" in calls and "retire" in calls and "код 1, но пусковой" in out):
    failed += 1
    print("FAIL: osascript error but the launcher started -> opened with a warning", rc, calls)
    print(out)
rc, out, calls, _ = osa_run("terminal", 0, start=False)  # osascript без ошибки, а скрипт не стартовал
if not (rc == 4 and "открыто:" not in out and "record" not in calls and "retire" not in calls):
    failed += 1
    print("FAIL: osascript ok but the launcher never started -> code 4", rc, calls)
    print(out)
rc, out, calls, _ = osa_run("terminal", 1, start=False, launch=True)
if not (rc == 4 and calls.count("osascript") == 1 and "plan — НЕ открыта: окно не открылось" in out
        and "дальше не открывал: окно plan не открылось" in out and "coord —" not in out and "wait" not in calls):
    failed += 1
    print("FAIL: --launch stops after the first window that did not open", rc, calls)
    print(out)

print("spawn_session: %d failed" % failed)
sys.exit(1 if failed else 0)
