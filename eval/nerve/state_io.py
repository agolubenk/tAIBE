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
