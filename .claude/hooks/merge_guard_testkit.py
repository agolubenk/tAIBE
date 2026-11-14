"""
Общее для проверок merge-guard (test_merge_guard.py, test_merge_guard_shell.py): хук, песочница, сессии, счётчики.
Проверки пишут в общие failures/checked; итог — finish().
"""
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("mg", Path(__file__).resolve().parent / "pre-tool-use-merge-guard.py")
mg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mg)


TMP = Path(tempfile.mkdtemp(prefix="merge-guard-test-"))
ROOT = TMP / "repo"
HOME = TMP / "home" / ".claude"
(ROOT / ".claude" / "rules").mkdir(parents=True)
(ROOT / "worktrees" / "fix" / "x" / ".claude" / "rules").mkdir(parents=True)
(HOME / "sessions").mkdir(parents=True)
sys.modules["merge_guard_paths"].HOME_CLAUDE = HOME  # protected_path читает HOME_CLAUDE своего модуля (SE-85)

D9 = {"sessionId": "d9d9d9d9-0000-0000-0000-000000000000", "name": "hr-helper-v2-d9", "pid": 1}
C4 = {"sessionId": "4c4c4c4c-0000-0000-0000-000000000000", "name": "hr-helper-v2-4c", "pid": 2}
SESSIONS = [D9, C4]
CONTROL = (["hr-helper-v2-d9"], None)

failures = []
checked = [0]


def run(tool, inp, who=C4, sessions=SESSIONS, control=CONTROL, cwd=ROOT):
    data = {"tool_name": tool, "tool_input": inp, "session_id": who["sessionId"], "cwd": str(cwd)}
    return mg.decide(data, lambda: sessions, lambda: control, roots=[str(ROOT)])


def check(label, got, want_deny):
    checked[0] += 1
    if (got is not None) != want_deny:
        failures.append(f"{label}: ждали {'отказ' if want_deny else 'проход'}, получили {got!r}")


def same(got, want):
    """Для check(…, same(f(x), want), False): None, только если got == want; иначе repr(got) — и неожиданный None тоже
    провал (`None if f(x) == want else f(x)` его пропускал)."""
    return None if got == want else repr(got)


def bash(label, cmd, want_deny, **kw):
    check(label, run("Bash", {"command": cmd}, **kw), want_deny)



def repo_on(branch, prefix=None):
    d = Path(tempfile.mkdtemp(dir=TMP, prefix=prefix))
    for args in (["init", "-q", "-b", branch], ["commit", "-q", "--allow-empty", "-m", "x"]):
        subprocess.run(["git", "-C", str(d), "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True)
    return d


def finish(what):
    if failures:
        print("\n".join(failures))
        sys.exit(1)
    print(f"merge-guard: все проверки прошли ({checked[0]} решений хука{what})")
