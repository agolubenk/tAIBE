"""
Сбой merge-guard (pre-tool-use-merge-guard.py, SE-152): внутренняя ошибка разбора или решения роль не пропускает.

Ожидаемый исход разбора — кавычка без пары или `\\` в конце текста (shlex; bash на них тоже даёт синтаксическую ошибку)
и исчерпанный бюджет git (GitTimeout, merge_guard_git: штатный исход, не сбой): решает грубый признак, как раньше.
Любая другая ошибка (TypeError, IndexError, RecursionError, …) — находка «сбой
хука»: она идёт тем же путём, что и защищённое действие, — роли отказ с текстом ошибки, Контролю проход
(control_verdict). Признак защищённого действия в вызове при сбое — отказ всем, как до SE-152.

Где ловится: сбой разбора команды и скрипта — merge_guard_partial.settled (обе точки разбора хука, crash);
сбой decide целиком — main хука (crash_verdict).

Решений о командах не принимает. Отдельный модуль — чтобы хук оставался в пределе 500 строк (01-base).
"""
import json
import re

from merge_guard_git import GitTimeout
from merge_guard_identity import control_verdict, live_sessions, load_control

SHLEX = ("No closing quotation", "No escaped character")
MERGE_TOOL = re.compile(r"merge_pull_request|auto_merge")


def expected(exc):
    """Ожидаемый исход разбора: shlex не нашёл пары кавычке или символа после `\\` в конце текста; бюджет git
    исчерпан (GitTimeout — «пропуск, не отказ», merge_guard_git.start_budget; линза backend #444, B1)."""
    return isinstance(exc, GitTimeout) or isinstance(exc, ValueError) and str(exc) in SHLEX


def crash_text(exc):
    """«Класс: текст» ошибки — в причину отказа, не длиннее 200 знаков."""
    return (f"{exc.__class__.__name__}: {exc}" if str(exc) else exc.__class__.__name__)[:200]


def crash(exc, where=""):
    """[] — ожидаемый исход разбора; иначе [находка «сбой хука»]. Вид находки несёт текст ошибки: он попадает в отказ."""
    if expected(exc):
        return []
    at = f" на {str(where)[:80]}" if where else ""
    return [(f"сбой хука{at} ({crash_text(exc)}) — роли отказ (SE-152); разбейте вызов на простые команды", where)]


def crash_verdict(data, exc, fallback, get_sessions=live_sessions, get_control=load_control):
    """Причина отказа после сбоя decide целиком (main); None — проход. fallback — грубый признак (FALLBACK хука):
    признак в вызове — отказ всем; без него ожидаемый исход (expected) — проход, как до SE-152; иначе Контроль идёт
    своим путём, роль — отказ. Сбой самой проверки — отказ."""
    data = data if isinstance(data, dict) else {}
    inp = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    tool = str(data.get("tool_name", ""))
    call = str(inp.get("command", "")) if tool == "Bash" else json.dumps(inp, ensure_ascii=False, default=str)
    if fallback.search(call) or MERGE_TOOL.search(tool):
        return f"merge-guard: сбой хука ({crash_text(exc)}), а в вызове признак защищённого действия."
    if expected(exc):
        return None
    try:
        control, err = get_control()
        why = err or control_verdict(str(data.get("session_id", "")), get_sessions(), control)
    except Exception as check:  # noqa: BLE001 — сбой проверки Контроля: личность не подтверждена
        why = f"проверка Контроля тоже упала ({crash_text(check)})"
    if why is None:
        return None
    return (f"merge-guard: сбой хука ({crash_text(exc)}) — роли отказ, Контролю проход (SE-152). {why}. "
            "Разбейте вызов на простые команды; повторяется — сообщите backend с текстом ошибки.")
