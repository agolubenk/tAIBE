"""
Кто я для merge-guard (pre-tool-use-merge-guard.py): живые сессии из реестра `~/.claude/sessions`, список Контроля
из основной папки и вердикт «эта сессия — Контроль». Решений о командах не принимает.
"""
import json
import os
from pathlib import Path

SESSIONS_DIR = Path.home() / ".claude" / "sessions"
# Список Контроля — всегда из основной папки: сессия, запущенная в worktree, свою папку править может.
MAIN_ROOT = Path(str(Path(__file__).resolve().parents[2]).split("/worktrees/", 1)[0])


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


def control_verdict(session_id, sessions, control):
    """None — Контроль; иначе причина отказа."""
    me = next((s for s in sessions if s.get("sessionId") == session_id), None)
    if me is None:
        return "не нашёл эту сессию в реестре ~/.claude/sessions — личность не подтверждена"
    sid, name = str(me.get("sessionId", "")), str(me.get("name", ""))
    if any(e == sid or (len(e) >= 8 and sid.startswith(e)) for e in control):
        return None
    if name and name in control:
        same = sum(1 for s in sessions if s.get("name") == name)
        if same == 1:
            return None
        return f"имя {name} у {same} живых сессий — по имени не пропускаю; владелец вписывает sessionId"
    return f"эта сессия — {name or '?'} ({sid[:8]}), её нет в списке Контроля"
