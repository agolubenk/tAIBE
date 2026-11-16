#!/usr/bin/env python3
"""
SE-152: сбой merge-guard роль не пропускает. Внутренняя ошибка разбора или решения — роли отказ с текстом ошибки,
Контроль идёт своим путём; кавычка без пары — ожидаемый исход разбора, решает грубый признак, как раньше.

Запуск: python3 -I .claude/hooks/test_merge_guard_crash.py  (exit 1 при расхождении)
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_guard_testkit import C4, CONTROL, D9, SESSIONS, TMP, bash, check, failures, finish, mg, run  # noqa: E402
import merge_guard_crash as mc  # noqa: E402


def want(label, got, text):
    """Отказ, и в его тексте — text."""
    check(label, got, True)
    if got is not None and text not in got:
        failures.append(f"{label}: в отказе нет «{text}»: {got!r}")


def boom(*_a, **_k):
    raise TypeError("cannot unpack non-iterable NoneType object")


# --- ожидаемый исход разбора и находка «сбой хука» ---
check("кавычка без пары — не сбой", mc.crash(ValueError("No closing quotation")) or None, False)
check("`\\` в конце — не сбой", mc.crash(ValueError("No escaped character")) or None, False)
check("другой ValueError — сбой", mc.crash(ValueError("invalid literal for int()")) or None, True)
kind, where = (mc.crash(TypeError("x"), "u.sh") or [("", "")])[0]
want("вид находки несёт класс, текст и место", kind or None, "на u.sh (TypeError: x)")
check("текст ошибки не длиннее 200 знаков", None if len(mc.crash_text(KeyError("k" * 500))) <= 200 else "длинный", False)

# --- сбой разбора команды (classify_bash): роли отказ, Контролю проход ---
real = mg.classify_bash
mg.classify_bash = boom
try:
    want("сбой разбора: роль, безобидная команда", run("Bash", {"command": "ls"}), "TypeError: cannot unpack")
    bash("сбой разбора: Контроль — своим путём", "ls", False, who=D9)
    bash("сбой разбора с признаком: Контролю отказ, как до SE-152", "gh pr merge 1", True, who=D9)
    want("сбой разбора: Контроля нет в списке — отказ", run("Bash", {"command": "ls"}, who=D9, control=([], "нет списка")),
         "TypeError")
finally:
    mg.classify_bash = real
bash("без сбоя: роль, безобидная команда — проход", "ls", False)
bash("кавычка без пары, признака нет — проход, как раньше", 'echo "unclosed', False)

# --- сбой разбора скрипта (script_found): роли отказ, Контролю проход ---
scripts = Path(tempfile.mkdtemp(dir=TMP, prefix="crash-"))
(scripts / "ok.sh").write_text("ls\n")
(scripts / "q.sh").write_text('ls\necho "\n')
real = mg.script_found
mg.script_found = boom
try:
    want("сбой разбора скрипта: роль", run("Bash", {"command": "bash ok.sh"}, cwd=scripts), "на ok.sh (TypeError")
    bash("сбой разбора скрипта: Контроль — своим путём", "bash ok.sh", False, who=D9, cwd=scripts)
finally:
    mg.script_found = real
bash("скрипт: кавычка без пары, признака нет — проход, как раньше", "bash q.sh", False, cwd=scripts)


# --- сбой decide целиком (main → crash_verdict) ---
def verdict(data, exc=KeyError("tool_input"), who=C4, control=CONTROL, sessions=SESSIONS):
    data = dict(data, session_id=who["sessionId"]) if isinstance(data, dict) else data
    return mc.crash_verdict(data, exc, mg.FALLBACK, lambda: sessions, lambda: control)


ls = {"tool_name": "Bash", "tool_input": {"command": "ls"}}
want("сбой decide: роль", verdict(ls), "KeyError: 'tool_input'")
check("сбой decide: Контроль — проход, как до SE-152", verdict(ls, who=D9), False)
want("сбой decide с признаком: отказ и Контролю", verdict({"tool_name": "Bash", "tool_input": {"command": "gh pr merge 1"}},
                                                         who=D9), "признак защищённого действия")
want("сбой decide: инструмент мёржа — отказ и Контролю", verdict({"tool_name": "mcp__github__merge_pull_request",
                                                                  "tool_input": {}}, who=D9), "KeyError")
want("сбой decide: признак в полях не-Bash", verdict({"tool_name": "Edit", "tool_input": {"file_path": ".claude/rules/x"}},
                                                     who=D9), "признак защищённого действия")
want("сбой decide: вход не словарь", mc.crash_verdict([], KeyError("x"), mg.FALLBACK, lambda: SESSIONS, lambda: CONTROL),
     "не нашёл эту сессию")
want("сбой decide: проверка Контроля упала — отказ",
     mc.crash_verdict(dict(ls, session_id=D9["sessionId"]), KeyError("x"), mg.FALLBACK, lambda: SESSIONS, boom),
     "проверка Контроля тоже упала (TypeError")

# --- хук целиком: настоящий сбой decide (commands — не список) ---
hook = Path(__file__).resolve().parent / "pre-tool-use-merge-guard.py"
out = subprocess.run([sys.executable, "-I", str(hook)], input=json.dumps({
    "tool_name": "mcp__plugin_context-mode_context-mode__ctx_batch_execute", "tool_input": {"commands": 5},
    "session_id": "no-such", "cwd": "/tmp"}), capture_output=True, text=True)
try:
    decision = json.loads(out.stdout)["hookSpecificOutput"]
    assert decision["permissionDecision"] == "deny" and "TypeError" in decision["permissionDecisionReason"]
except Exception as exc:  # noqa: BLE001
    failures.append(f"хук целиком, сбой decide: ждали deny с TypeError, получили {out.stdout!r} {out.stderr[-300:]!r} ({exc})")

finish(" — сбой хука, SE-152")
