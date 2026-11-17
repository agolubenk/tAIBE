#!/usr/bin/env python3
"""
PreToolUse — вход merge-guard (SE-168). Хук `pre-tool-use-merge-guard.py` импортирует 15 своих модулей на верхнем уровне;
сбой импорта (синтаксис, удалённый или сломанный модуль) ронял процесс до `main()`, `|| true` в settings.json давал код 0
без решения — вызов проходил. Этот файл грузит хук внутри `try`: любой сбой загрузки или разбора решается так же, как
сбой разбора в `main()` хука — отказ, если в вызове есть признак защищённого действия (FALLBACK), иначе проход.
Здесь только stdlib: файл должен загружаться, даже когда сломан любой модуль хука.
"""
import importlib.util
import io
import json
import re
import sys
from pathlib import Path

FALLBACK = re.compile(  # разбор упал — защищённой считается команда, где есть хоть один из этих признаков
    r"gh\s+pr\s+merge|gh\s+workflow\s+run|gh\s+run\s+rerun|\bgit\b[^\n;|&]*\bpush\b|/merge\b|mergePullRequest"
    r"|/dispatches|\.claude/(rules|hooks|settings|merge-guard|sessions)", re.I
)  # re.I: APFS не различает регистр — `.CLAUDE/rules` (SE-94, HR IS-245)
HOOK = Path(__file__).resolve().with_name("pre-tool-use-merge-guard.py")


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
