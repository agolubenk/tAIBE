#!/usr/bin/env python3
"""
PreToolUse — вход merge-guard (SE-168). Хук `pre-tool-use-merge-guard.py` импортирует 15 своих модулей на верхнем уровне;
сбой импорта (синтаксис, удалённый или сломанный модуль) ронял процесс до `main()`, `|| true` в settings.json давал код 0
без решения — вызов проходил. Этот файл грузит хук внутри `try`: любой сбой загрузки или разбора решается так же, как
сбой разбора в `main()` хука — отказ, если в вызове есть признак защищённого действия, иначе проход.
Здесь только stdlib, и уровень модуля не зависит от модулей хука: файл должен загружаться, даже когда сломан любой из них.

Сбой внутри decide хук решает сам (crash_verdict, SE-152): там модули целы, и Контроль идёт своим путём. Сюда доходят
только сбой загрузки и исключения мимо `except Exception` хука (SystemExit и т. п.). Личность здесь не проверить —
модули проверки могут быть сломаны, — поэтому решает только признак, и он шире признака хука: тот же текст (ядро, любой
`.claude`, файлы ~ — HOME_WRITE, SE-98) плюс защищённые классы, которые хук ловит по личности (MCP github, вердикт мёржа
в очереди, REST и GraphQL мёржа и прогонов, перенос строки). Это сверяют тесты.
"""
import importlib.util
import io
import json
import re
import sys
from pathlib import Path

HOOK = Path(__file__).resolve().with_name("pre-tool-use-merge-guard.py")
sys.path.insert(0, str(HOOK.parent))  # python3 -I не кладёт папку скрипта в sys.path — как в хуке
CORE = (r"gh\s+pr\s+merge|gh\s+workflow\s+run|gh\s+run\s+rerun|\bgit\b[^\n;|&]*\bpush\b|/merge\b|mergePullRequest"
        r"|/dispatches|\.claude\b"  # `.claude` — любой путь и `cd .claude`: шире списка хука
        r"|/merges\b|/rerun|enablePullRequestAutoMerge|mergeBranch|createCommitOnBranch|updateRefs?\b|/git/refs/")
# Модуль файлов ~ сломан — любое имя rc/profile/env/login/logout-файла в точке (шире SHELL_INIT хука)
HOME_SPARE = r"(?<![\w.])\.\w*(rc|profile|env|login|logout)(?![\w.])"
SPARE = re.compile(CORE + "|" + HOME_SPARE, re.I)  # re.I: APFS не различает регистр — `.CLAUDE/rules` (SE-94)
FALLBACK = SPARE
try:  # файлы ~ из модуля хука (SE-98) — только добавкой: сломанный или чужой шаблон не роняет вход
    from merge_guard_home import HOME_WRITE
    FALLBACK = re.compile(SPARE.pattern + "|" + HOME_WRITE.pattern, re.I)
except BaseException:  # noqa: BLE001 — вход не падает из-за модуля хука
    pass
TOOL = re.compile(r"merge_pull_request|auto_merge|github.*(run_workflow|rerun|dispatch|actions_run_trigger|push_files"
                  r"|create_or_update_file|delete_file)", re.I)
VERDICT = ("sha", "base", "deploy", "pr", "cmd", "cmd2", "chips")  # поля m-пункта, которые читает мёрж владельца


def queue_verdict(tool, inp):
    """Запись в очереди, похожая на вердикт мёржа: m-пункт, kind merge или поле мёржа (хук решает это по личности)."""
    if not re.search(r"oq_put|oq_patch", tool) or inp.get("collection") != "items":
        return False
    data = inp.get("data") if isinstance(inp.get("data"), dict) else {}
    return bool(re.search(r"(^|-)m-", str(inp.get("id", ""))) or data.get("kind") == "merge"
                or any(data.get(k) is not None for k in VERDICT))


def failure_reason(data, exc):
    """Причина отказа при сбое хука или None — проход: сбой не должен ни пропускать мёрж, ни блокировать всё подряд."""
    tool = str(data.get("tool_name"))
    inp = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    texts = [str(inp.get("command", ""))] + ([] if tool == "Bash" else [json.dumps(inp, ensure_ascii=False)])
    texts = [re.sub(r"\\\r?\n", " ", t) for t in texts]  # `git -C x \⏎ push`: bash склеивает строки
    if any(FALLBACK.search(t) for t in texts) or TOOL.search(tool) or queue_verdict(tool, inp):
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
