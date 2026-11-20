"""Токены (R-5): из окружения, иначе через имеющийся `secret_cmd` (`instances/_shared.json` `queue.secret_cmd`:
окружение, затем Keychain). Значение отдаётся только транспорту;
в вывод, причины отказа и исключения оно не попадает."""
import json
import os
import subprocess

from .net import ROOT


def token(name, root=ROOT, env=None, runner=subprocess.run):
    """Значение секрета `name` или None — секрета нет (вызывающий решает: SourceDown(источник, «нет <name>»))."""
    env = os.environ if env is None else env
    value = (env.get(name) or "").strip()
    if value:
        return value
    try:
        with open(os.path.join(root, "instances", "_shared.json"), encoding="utf-8") as f:
            cmd = json.load(f)["queue"]["secret_cmd"]
        p = runner(["bash", os.path.join(root, cmd), name], capture_output=True, text=True, timeout=5, cwd=root,
                   stdin=subprocess.DEVNULL)
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        return None
    if p.returncode != 0:
        return None
    return (p.stdout or "").strip() or None
