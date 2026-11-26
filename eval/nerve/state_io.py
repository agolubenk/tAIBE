"""Нерв: чтение и запись файлов состояния (state.json, mode.json, cycle.json, пульс). Вынесено из nerve.py
(лимит 500 строк, ревью #103); nerve.py реэкспортирует load_json и save_json, вызовы не меняются."""
import json
import os


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    tmp = f"{path}.tmp{os.getpid()}"   # свой tmp у процесса: два tap одной роли не рвут файл друг другу
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def read_heartbeat(state_dir):
    """Пульс — из файла state/heartbeat (25 Б, пишется каждым проходом), а не из state.json (≈1 МБ каждые 15 с);
    нет файла (демон старее) — из state.json, как раньше."""
    try:
        with open(os.path.join(state_dir, "heartbeat"), encoding="utf-8") as f:
            hb = f.read().strip()
        if hb:
            return hb
    except OSError:
        pass
    st = load_json(os.path.join(state_dir, "state.json"), {})
    return st.get("heartbeat") if isinstance(st, dict) else None


def write_pulse(state_dir, source, pass_started, at):
    """SE-70: state/pulse (~100 Б) — перед каждым источником прохода: тап отличает долгий проход от мёртвого демона.
    Сбой записи демон не валит (пульс прохода — подсказка, не данные)."""
    try:
        save_json(os.path.join(state_dir, "pulse"), {"pass": pass_started, "source": source, "at": at})
    except (OSError, TypeError, ValueError):
        pass


def read_pulse(state_dir):
    p = load_json(os.path.join(state_dir, "pulse"), {})
    return p if isinstance(p, dict) else {}


SHARED_COMMANDS = ("emit", "tap", "status")   # SE-171: команды, которым нужно состояние живого демона


def main_checkout(here):
    """(корень основного checkout, верх worktree), если `here` лежит в linked git worktree; иначе None.
    Верх worktree — первый вверх `.git`-файл «gitdir: <common>/worktrees/<имя>»; основной — родитель `<common>`
    из `commondir`. Только чтение файлов, без процесса git: emit и tap частые (SE-171). Папка `.git` — сам основной
    checkout; подмодуль (нет `commondir`) и голый репозиторий — None."""
    top = os.path.abspath(here)
    while not os.path.lexists(os.path.join(top, ".git")):
        if os.path.dirname(top) == top:
            return None
        top = os.path.dirname(top)
    dot = os.path.join(top, ".git")
    if not os.path.isfile(dot):
        return None
    try:
        with open(dot, encoding="utf-8") as f:
            line = f.readline().strip()
        if not line.startswith("gitdir:"):
            return None
        gitdir = os.path.join(top, line[len("gitdir:"):].strip())
        with open(os.path.join(gitdir, "commondir"), encoding="utf-8") as f:
            common = os.path.normpath(os.path.join(gitdir, f.readline().strip()))
    except OSError:
        return None
    root = os.path.dirname(common)
    return (root, top) if os.path.basename(common) == ".git" and os.path.isdir(root) else None


def shared_state_dir(here, state_dir, cmd):
    """SE-171: emit, tap и status из linked worktree пишут и читают состояние основного checkout — его читают демон
    и тапы ролей; копия в worktree — журнал, которого никто не видит. Остаются как есть: run и once (песочница ветки),
    NERVE_STATE_DIR (тесты, песочницы) и папка, которую задал не код по умолчанию (тест подменил STATE_DIR)."""
    if cmd not in SHARED_COMMANDS or os.environ.get("NERVE_STATE_DIR") or \
            os.path.normpath(state_dir) != os.path.normpath(os.path.join(here, "state")):
        return state_dir
    found = main_checkout(here)
    if found is None:
        return state_dir
    root, top = found
    main_here = os.path.join(root, os.path.relpath(os.path.abspath(here), top))
    return os.path.join(main_here, "state") if os.path.isdir(main_here) else state_dir
