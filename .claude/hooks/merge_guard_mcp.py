"""
MCP для merge-guard (pre-tool-use-merge-guard.py): мёрж, деплой и запись в защищённую ветку через GitHub MCP, вердикт мёржа и
подпись в очереди владельца, пути пишущих MCP-инструментов (serena и подобные). Имена — и прямые, и через хаб
(`mcp__hub__<сервер>_1mcp_<операция>`).
"""
import re

from merge_guard_git import MAIN_WRITE, is_protected

MERGE = "мёрж PR"
DEPLOY = "деплой или повтор прогона GitHub Actions"


def mcp_op(tool):
    """Имя операции MCP, в том числе через хаб: mcp__hub__github_1mcp_merge_pull_request → merge_pull_request."""
    return re.split(r"__|_1mcp_", tool)[-1]


def oq_op(tool, *ops):
    """Операция очереди владельца по имени операции, а не сервера: вложенный `claude --mcp-config` подключает тот же
    сервер под любым именем (mcp__q__oq_agent_status) — GLM HR #602, безопасность 2. Хук зовёт только в ветке
    tool.startswith("mcp__")."""
    return mcp_op(tool) in ops


def classify_mcp(tool, inp, cwd="."):
    op = mcp_op(tool)
    if tool.startswith("mcp__") and "github" in tool.lower():
        if op == "merge_pull_request" or "auto_merge" in op:
            return MERGE
        if op in ("push_files", "create_or_update_file", "delete_file"):
            branch = str(inp.get("branch") or "")
            return MAIN_WRITE if not branch or is_protected(branch, cwd) else None
        if re.search(r"run_workflow|rerun|dispatch|actions_run_trigger", op):
            return DEPLOY
    return None


APPROVAL_FIELDS = {"sha", "base"}
MERGE_ITEM_FIELDS = APPROVAL_FIELDS | {"deploy", "pr", "cmd", "cmd2", "chips", "kind"}


def oq_merge_write(tool, inp):
    """Вердикт «Контроля» в очереди: ops-console вливает по полям sha + base пункта мёржа, а deploy, cmd с [skip ci]
    и метка «без деплоя» снимают защиту «идёт деплой». Токен MCP у всех сессий один — различает только этот хук."""
    if not oq_op(tool, "oq_put", "oq_patch") or inp.get("collection") != "items":
        return None
    data = inp.get("data") if isinstance(inp.get("data"), dict) else {}
    keys = {k for k, v in data.items() if v is not None}
    merge_item = str(inp.get("id", "")).startswith("m-") or data.get("kind") == "merge"
    if keys & APPROVAL_FIELDS or (merge_item and keys & MERGE_ITEM_FIELDS):
        return "вердикт или параметры мёржа в очереди владельца (sha, base, deploy, pr, cmd)"
    return None


WRITE_OP = re.compile(r"replace|insert|rename|delete|remove|write|create|edit|move|update|patch|save|apply|upload")


def mcp_paths(inp):
    """Пути во входе MCP-инструмента: значения ключей со словом path (строка или список строк)."""
    for k, v in inp.items():
        if "path" in k.lower():
            yield from ([v] if isinstance(v, str) else [x for x in v if isinstance(x, str)] if isinstance(v, list) else [])


LINE_RE = re.compile(r"r(?:\.[a-z0-9]+)+")  # линия сессии, как у сервера очереди (heirOf в ops-console store.ts)


def oq_identity(tool, inp, sid, get_sessions, line_check=None):
    """None — пропустить; иначе причина отказа. `session` у oq_agent_status — захват входящего (409 у чужой сессии):
    своё имя из реестра или линия. Линию и `takeover` (перехват у держателя, OPS-35) проверяет
    line_check(pid, session, takeover) — merge_guard_identity.oq_line_verdict; без неё линия не проходит.
    source у items и session у work не проверяются: Координатор законно ставит их за исполнителя."""
    if not oq_op(tool, "oq_agent_status"):
        return None
    value = str(inp.get("session") or "").strip()
    takeover = str(inp.get("takeover") or "").strip() or None
    if not value:
        return "в oq_agent_status takeover — только вместе с session (своей линией)" if takeover else None
    me = next((s for s in get_sessions() if s.get("sessionId") == sid), None)
    if LINE_RE.fullmatch(value) or takeover:
        if not LINE_RE.fullmatch(value):
            return f"в oq_agent_status takeover — только с линией в session, а не «{value[:60]}»"
        try:
            pid = int(me.get("pid")) if me else None
        except (TypeError, ValueError):
            pid = None
        why = line_check(pid, value, takeover) if line_check else "проверка линии не подключена"
        return None if why is None else f"в oq_agent_status {why}"
    name = str(me.get("name", "")) if me else ""
    if not name:
        return "в oq_agent_status session — только своё имя, а этой сессии нет в реестре ~/.claude/sessions"
    if value in (name, name.rsplit("-", 1)[-1]):
        return None
    return f"в oq_agent_status session — только своё имя ({name}), а не «{value[:60]}»"
