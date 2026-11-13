"""
Кто я для merge-guard (pre-tool-use-merge-guard.py): живые сессии из реестра `~/.claude/sessions`, список Контроля
из основной папки и вердикт «эта сессия — Контроль». Решений о командах не принимает.

Запись списка — sessionId (≥ 8 символов), имя сессии или линия `line:<L>` (TB-81). По линии Контроль — один
держатель: среди живых сессий поддерева L той же роли, что запись корня L (`role` в `<L>.json`), — наследник
с самой новой своей квитанцией приёма (`lineage.py ack`); нет такого — сам корень. Наследник другой роли, без роли
в записи или без своей квитанции не проходит; равные квитанции братьев — отказ обоим. Смена поколения Контроля не
требует правки списка владельцем. Линию сессии, записи и квитанции читает `eval/tools/lineage.py`; нет модуля —
запись линии никого не пропускает.
"""
import importlib.util
import json
import os
from pathlib import Path

SESSIONS_DIR = Path.home() / ".claude" / "sessions"
# Список Контроля — всегда из основной папки: сессия, запущенная в worktree, свою папку править может.
MAIN_ROOT = Path(str(Path(__file__).resolve().parents[2]).split("/worktrees/", 1)[0])
LINE_PREFIX = "line:"
LINEAGE_PATHS = ("eval/tools/lineage.py", ".claude/scripts/lineage.py")


def live_sessions(sessions_dir=SESSIONS_DIR):
    out = []
    for f in Path(sessions_dir).glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            os.kill(int(d["pid"]), 0)
        except (OSError, ValueError, KeyError, TypeError):
            continue
        out.append(d)
    return out


def load_control(project_dir=MAIN_ROOT):
    """Список Контроля; локальный файл целиком заменяет общий. Испорченный файл — пустой список (никому)."""
    for name in ("merge-guard.local.json", "merge-guard.json"):
        f = Path(project_dir) / ".claude" / name
        if not f.exists():
            continue
        try:
            control = json.loads(f.read_text(encoding="utf-8"))["control"]
            if isinstance(control, list) and all(isinstance(x, str) for x in control):
                return control, None
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return [], f"{f} испорчен — до исправления Контроля нет"
    return [], ".claude/merge-guard.json не найден — Контроля нет"


def load_protected(project_dir=None):
    """Добавочные защищённые ветки — `protected` из обоих файлов списка, объединением: файл только добавляет защиту,
    снять main/master или основную ветку remote им нельзя. Нужен, если у клона не задан origin/HEAD. Испорченный
    файл ничего не добавляет. Папка по умолчанию — MAIN_ROOT на момент вызова (тест подменяет)."""
    out = set()
    for name in ("merge-guard.local.json", "merge-guard.json"):
        try:
            extra = json.loads((Path(project_dir or MAIN_ROOT) / ".claude" / name).read_text(encoding="utf-8"))
            extra = extra.get("protected", [])
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(extra, list):
            out |= {x.removeprefix("refs/heads/") for x in extra if isinstance(x, str) and x}
    return out


def load_lineage(project_dir=None):
    """Модуль lineage.py основной папки или None."""
    for rel in LINEAGE_PATHS:
        path = Path(project_dir or MAIN_ROOT) / rel
        if path.is_file():
            spec = importlib.util.spec_from_file_location("merge_guard_lineage", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    return None


def _role(lin, line):
    rec = lin.read_json(lin.lfile(line, ".json"))
    role = rec.get("role") if isinstance(rec, dict) else None
    return role if isinstance(role, str) and role else None


def _live_ack(lin, sx, line):
    """Квитанция линии, если её процесс жив (тот же pid и старт); иначе None."""
    ack = lin.read_json(lin.lfile(line, ".ack"))
    if not isinstance(ack, dict) or not ack.get("start") or not ack.get("at"):
        return None
    try:
        pid = int(ack.get("pid"))
    except (TypeError, ValueError):
        return None
    return ack if sx.alive(lin.Proc(pid, 0, 0, "", str(ack["start"]), "")) else None


def line_holders(lin, sx, root):
    """Держатели линии root: [линия наследника] с самой новой живой квитанцией той же роли (на любой глубине, через
    любые поколения без квитанции); несколько — при равных квитанциях; [] — держит сам корень."""
    role = _role(lin, root)
    if role is None:
        return []
    acked = [(str(ack["at"]), line) for line, _ in lin.line_records()
             if line.startswith(root + ".") and _role(lin, line) == role and (ack := _live_ack(lin, sx, line))]
    if not acked:
        return []
    newest = max(at for at, _ in acked)
    return sorted(line for at, line in acked if at == newest)


def line_verdict(pid, lines, lin=None, sx=None):
    """None — сессия pid держит одну из линий lines; иначе причина отказа."""
    lin = lin or load_lineage()
    if lin is None:
        return "в списке Контроля линия, а eval/tools/lineage.py не найден"
    sx = sx or lin.Sys()
    p = sx.procs().get(pid) if isinstance(pid, int) else None
    if p is None:
        return f"процесс сессии {pid} не найден"
    mine = lin.session_line(sx, p)
    if not mine or not lin.valid_line(mine):
        return "у сессии нет линии (её открыл не spawn_session.sh)"
    for root in lines:
        if mine != root and not mine.startswith(root + "."):
            continue
        if mine != root:
            role = _role(lin, root)
            if role is None or _role(lin, mine) != role:
                return (f"линия {mine} — потомок {root} не той роли (корень: {role or 'без роли'}, "
                        f"эта: {_role(lin, mine) or 'без роли'}); наследник Контроля — spawn_session.sh --handoff --role")
            ack = lin.read_json(lin.lfile(mine, ".ack")) or {}
            if str(ack.get("pid")) != str(p.pid) or lin.norm(ack.get("start")) != lin.norm(p.start):
                return f"линия {mine} — наследник {root} без своей квитанции приёма (lineage.py ack)"
        holders = line_holders(lin, sx, root)
        if (not holders and mine == root) or holders == [mine]:
            return None
        if len(holders) > 1:
            return f"у линии {root} несколько держателей с равной квитанцией ({', '.join(holders)}) — отказ всем"
        return f"линию {root} держит {holders[0] if holders else root}, не {mine}"
    return f"линия сессии {mine} не из линий Контроля ({', '.join(lines)})"


def control_verdict(session_id, sessions, control, line_check=line_verdict):
    """None — Контроль; иначе причина отказа."""
    me = next((s for s in sessions if s.get("sessionId") == session_id), None)
    if me is None:
        return "не нашёл эту сессию в реестре ~/.claude/sessions — личность не подтверждена"
    sid, name = str(me.get("sessionId", "")), str(me.get("name", ""))
    lines = [e[len(LINE_PREFIX):] for e in control if e.startswith(LINE_PREFIX)]
    control = [e for e in control if not e.startswith(LINE_PREFIX)]
    if any(e == sid or (len(e) >= 8 and sid.startswith(e)) for e in control):
        return None
    if name and name in control:
        same = sum(1 for s in sessions if s.get("name") == name)
        if same == 1:
            return None
        return f"имя {name} у {same} живых сессий — по имени не пропускаю; владелец вписывает sessionId"
    why_line = None
    if lines:
        try:
            pid = int(me.get("pid"))
        except (TypeError, ValueError):
            pid = None
        why_line = line_check(pid, lines)
        if why_line is None:
            return None
    return f"эта сессия — {name or '?'} ({sid[:8]}), её нет в списке Контроля" + (f"; {why_line}" if why_line else "")
