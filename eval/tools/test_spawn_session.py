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
proc = dry_run({"CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDECODE": "1", "TAIBE_LINEAGE": "r.ab12"})
lines = proc.stdout.splitlines()
unset_at = next((i for i, ln in enumerate(lines) if ln.startswith("unset ") and "CLAUDE_CODE_CHILD_SESSION" in ln), None)
exec_at = next((i for i, ln in enumerate(lines) if ln.startswith("exec ")), None)
for name, ok in [
    ("dry-run succeeds", proc.returncode == 0),
    ("launcher unsets CLAUDE_CODE_CHILD_SESSION and CLAUDECODE",
     unset_at is not None and "CLAUDECODE" in lines[unset_at]),
    ("unset comes before exec claude", unset_at is not None and exec_at is not None and unset_at < exec_at),
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

print("spawn_session: %d failed" % failed)
sys.exit(1 if failed else 0)
