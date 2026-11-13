#!/usr/bin/env python3
"""spawn_session.sh: a successor starts as a top-level session — inherited child-session markers are dropped
before `claude` runs, so its transcript is saved (hooks, eval measurements and claude-mem read it); every
descendant gets its own lineage id under its parent's.

Run: python3 -I eval/tools/test_spawn_session.py   (exit 1 on mismatch; --dry-run only, nothing is launched)
"""
import json
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

# SE-72: --launch не открывает release, пока в merge-guard (папка --cwd или tAIBE) записан Контроль, — и с --force.
# Новый Контроль при записанном — только --force-fresh-control. Остальные роли открываются, код выхода 3.
def control_run(cwd_list, tai_list, *flags, tai_text=None):
    sys.path.insert(0, str(SCRIPT.parent))
    from lineage_guard_fs import GUARD  # noqa: E402 — путь списка Контроля тот же, что читает хук
    with tempfile.TemporaryDirectory() as tmp:
        dirs = {}
        for name, ctl, text in (("prod", cwd_list, None), ("tai", tai_list, tai_text)):
            d = Path(tmp) / name
            subprocess.run(["git", "init", "-q", str(d)], check=True, timeout=30)
            if ctl is not None or text is not None:
                (d / GUARD).parent.mkdir()
                (d / GUARD).write_text(text if text is not None else json.dumps({"control": ctl}) + "\n",
                                       encoding="utf-8")
            dirs[name] = d
        listed = dirs["prod"] / GUARD
        before = listed.read_bytes() if listed.exists() else None
        env = {**os.environ, "TMPDIR": tmp, "CLAUDE_SESSIONS_DIR": os.path.join(tmp, "sess"),
               "TAIBE_LINEAGE_DIR": os.path.join(tmp, "lin"), "NERVE_PLIST": os.path.join(tmp, "none.plist"),
               "SPAWN_GUARD_TAIBE": str(dirs["tai"])}
        run = subprocess.run(["bash", str(SCRIPT), "--launch", "--roles", "coord,release", "--dry-run",
                              "--cwd", str(dirs["prod"]), *flags], capture_output=True, text=True, env=env, timeout=60)
        after = listed.read_bytes() if listed.exists() else None
        return run.returncode, run.stdout + run.stderr, before == after


SID = "0123abcd-0000-4000-8000-000000000000"
for name, cwd_list, tai_list, flags, opened, extra in [
    ("Control in the product guard: release refused", [SID], None, [], False, "prod:0123abcd"),
    ("--force does not bypass the Control check", [SID], None, ["--force"], False, "prod:0123abcd"),
    ("Control only in the tAIBE guard: release refused", None, [SID], [], False, "tai:0123abcd"),
    ("--force-fresh-control opens release", [SID], [SID], ["--force-fresh-control"], True, None),
    ("no guard files: release opens", None, None, [], True, None),
    ("empty Control lists: release opens", [], [], [], True, None),
]:
    rc, out, same = control_run(cwd_list, tai_list, *flags)
    ok = (same and "# coord: вставить" in out and ("# release: вставить" in out) == opened
          and rc == (0 if opened else 3)
          and (opened or ("release — НЕ открыта: Контроль записан в merge-guard: " + extra in out
                          and "--handoff" in out)))
    if not ok:
        failed += 1
        print("FAIL: SE-72", name, "rc", rc)
        print(out)
rc, out, same = control_run(None, None, tai_text="{not json")
if rc != 3 or "# release: вставить" in out or "не читается" not in out:
    failed += 1
    print("FAIL: SE-72 unreadable guard refuses release (fail-closed)")
    print(out)

print("spawn_session: %d failed" % failed)
sys.exit(1 if failed else 0)
