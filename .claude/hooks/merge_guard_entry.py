#!/usr/bin/env python3
"""
PreToolUse — вход merge-guard (SE-168). Хук `pre-tool-use-merge-guard.py` импортирует 15 своих модулей на верхнем уровне;
сбой импорта (синтаксис, удалённый или сломанный модуль) ронял процесс до `main()`, `|| true` в settings.json давал код 0
без решения — вызов проходил. Этот файл грузит хук внутри `try`: любой сбой загрузки или разбора решается так же, как
сбой разбора в `main()` хука — отказ, если в вызове есть признак защищённого действия (FALLBACK), иначе проход.
Здесь только stdlib: файл должен загружаться, даже когда сломан любой модуль хука.

Сбой внутри decide хук решает сам (crash_verdict, SE-152): там модули целы, и Контроль идёт своим путём. Сюда доходят
только сбой загрузки и исключения мимо `except Exception` хука (SystemExit и т. п.). Личность здесь не проверить —
модули проверки могут быть сломаны, — поэтому решает только признак. FALLBACK входа не уже FALLBACK хука: то же ядро,
любой путь `.claude/` и файлы ~, которые shell выполняет до команды (HOME_WRITE, SE-98). Это сверяет тест.
"""
import importlib.util
import io
import json
import re
import sys
from pathlib import Path

HOOK = Path(__file__).resolve().with_name("pre-tool-use-merge-guard.py")
sys.path.insert(0, str(HOOK.parent))  # python3 -I не кладёт папку скрипта в sys.path — как в хуке
# Модуль файлов ~ сломан — любое имя rc/profile/env/login/logout-файла в точке (шире SHELL_INIT хука)
HOME_SPARE = r"(?<![\w.])\.\w*(rc|profile|env|login|logout)(?![\w.])"
try:  # файлы ~ из модуля хука (SE-98)
    from merge_guard_home import HOME_WRITE
    HOME = HOME_WRITE.pattern
except Exception:  # noqa: BLE001 — вход не падает из-за модуля хука
    HOME = HOME_SPARE
FALLBACK = re.compile(  # разбор упал — защищённой считается команда, где есть хоть один из этих признаков
    r"gh\s+pr\s+merge|gh\s+workflow\s+run|gh\s+run\s+rerun|\bgit\b[^\n;|&]*\bpush\b|/merge\b|mergePullRequest"
    r"|/dispatches|\.claude/|" + HOME, re.I  # `.claude/` — любой путь: шире списка хука
)  # re.I: APFS не различает регистр — `.CLAUDE/rules` (SE-94, HR IS-245)


def failure_reason(data, exc):
    """Причина отказа при сбое хука или None — проход: сбой не должен ни пропускать мёрж, ни блокировать всё подряд."""
    inp = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    cmd = str(inp.get("command", "")) if data.get("tool_name") == "Bash" else json.dumps(inp, ensure_ascii=False)
    if FALLBACK.search(cmd) or re.search(r"merge_pull_request|auto_merge", str(data.get("tool_name"))):
        return (f"merge-guard: сбой хука ({exc.__class__.__name__}: {str(exc)[:160]}), а в вызове признак защищённого "
                "действия. Хук чинит владелец из своего терминала; роль сообщает координатору.")
    return None


def main(hook=HOOK):
    raw = sys.stdin.read()
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return
    try:
        spec = importlib.util.spec_from_file_location("merge_guard_hook", hook)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        sys.stdin = io.StringIO(raw)
        mod.main()
    except BaseException as exc:  # noqa: BLE001 — сбой загрузки или main() хука (и SystemExit) — не проход
        reason = failure_reason(data if isinstance(data, dict) else {}, exc)
        if reason:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}},
                ensure_ascii=False))


if __name__ == "__main__":
    main()
