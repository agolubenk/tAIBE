"""
Обёртка тяжёлого гейта для merge-guard (pre-tool-use-merge-guard.py, SE-116): какую команду она запустит.

Решений не принимает. Отдельный модуль — чтобы merge_guard_shell.py оставался в пределе 500 строк (01-base) и после
PR стража SE-75 (Control #338).
"""
from merge_guard_shell import SHELLS, command_name

GATE = "heavy-gate.sh"  # обёртка тяжёлого гейта (SE-116): `exec "$@"` — хвост её argv и есть команда


def gate_tail(a):
    """Команда, которую запустит обёртка тяжёлого гейта (a — после normalize): хвост после `heavy-gate.sh`,
    `bash|sh … heavy-gate.sh`, `source … heavy-gate.sh`, иначе []. Подсказка хука heavy-gate сама заворачивает в неё
    исходную команду (`heavy-gate.sh bash -c '<команда>'`), а текст скрипта хвоста не называет (backend #338 B1).
    В WRAPPERS обёртки нет: тот же normalize зовёт хук heavy-gate, и `heavy-gate.sh pnpm test` стал бы у него голым
    `pnpm test`."""
    if a[0] == GATE:
        return a[1:]
    if a[0] in SHELLS or a[0] in ("source", "."):
        k = next((k for k, x in enumerate(a[1:], 1) if command_name(x) == GATE), None)
        return a[k + 1:] if k else []
    return []
