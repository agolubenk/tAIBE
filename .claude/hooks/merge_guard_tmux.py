"""
merge-guard: окна сессий в tmux (OPS-82). Роли Claude живут окнами одного сервера tmux (eval/tools/tmux_host.py):
`send-keys` в окно Контроля — тот же обход «вливает только Контроль», что ввод от имени владельца; `capture-pane` и
буферы читают чужой экран; `#(…)` в формате, `run-shell`, `if-shell`, `-c` и хуки выполняют команду в сервере мимо
разбора этого хука. Агенту — только чтение списков; остальное — руками владельца, Контролю тоже нет.
Окна открывает spawn_session.sh (через tmux_host.py), закрывает сторож retire — их вызовы tmux этот хук не видит.
Подкоманды — по списку разрешённых: сокращение (`send` → send-keys) и псевдоним вне списка — тоже отказ.
"""
TMUX = "ввод, экран или управление окнами сессий в tmux (OPS-82)"
READ_ONLY = {"list-sessions", "ls", "list-windows", "lsw", "list-panes", "lsp", "list-clients", "lsc", "has-session",
             "has", "display-message", "display", "show-options", "show", "show-window-options", "showw",
             "show-environment", "showenv"}
GLOBAL_VALUED = set("LSfT")  # -L имя, -S сокет, -f конфиг, -T возможности терминала
GLOBAL_BOOL = set("2uvVNl")  # -C (команды из stdin), -c (команда оболочки), -D (сервер) — нет: отказ
# `tmux lsw \; send-keys …`: разбор shell в хуке делит команду и по `\;` — хвост цепочки приходит отдельной командой с
# именем подкоманды tmux. Программ с такими именами нет: отказ по имени. Только однозначные — без `run`, `source`, `at`,
# `new`, `a`, `if`: это настоящие команды и встроенные shell.
CHAIN_TAIL = {"send-keys", "send", "send-prefix", "capture-pane", "capturep", "pipe-pane", "pipep", "kill-pane", "killp",
              "kill-window", "killw", "kill-session", "kill-server", "respawn-pane", "respawnp", "respawn-window",
              "respawnw", "run-shell", "if-shell", "set-hook", "source-file", "new-window", "neww", "split-window",
              "splitw", "new-session", "attach-session", "paste-buffer", "pasteb", "load-buffer", "loadb", "set-buffer",
              "setb", "show-buffer", "showb", "save-buffer", "saveb", "set-option", "set-window-option", "setw",
              "set-environment", "setenv", "command-prompt", "display-popup", "popup", "bind-key", "unbind-key"}


def _commands(words):
    """Команды цепочки `a ; b` и `a\\; b` (shell отдаёт `;` отдельным словом или в конце слова)."""
    out, cur = [], []
    for w in words:
        if w == ";" or (w.endswith(";") and not w.endswith("\\;")):
            if w != ";":
                cur.append(w[:-1])
            out.append(cur)
            cur = []
        else:
            cur.append(w)
    return out + [cur]


def classify_tmux(a):
    """TMUX, если команда tmux не только читает списки или это хвост её цепочки; иначе None. a — argv без префиксов,
    имя без пути и регистра (normalize). Хук зовёт её для всякой команды, кроме gh, curl и их соседей."""
    if a and a[0] in CHAIN_TAIL:
        return TMUX
    if not a or a[0] != "tmux":
        return None
    i, version = 1, False
    while i < len(a) and a[i].startswith("-") and a[i] != "-":
        if a[i] == "--":
            i += 1
            break
        flags = a[i][1:]
        for k, f in enumerate(flags):
            if f in GLOBAL_VALUED:
                i += 0 if flags[k + 1:] else 1  # значение — остаток связки или следующее слово
                break
            if f not in GLOBAL_BOOL:
                return TMUX
            version = version or f == "V"
        i += 1
    rest = a[i:]
    if not rest:
        return None if version else TMUX  # `tmux` без команды — новая сессия с подключением
    if any("#(" in w for w in rest):
        return TMUX  # формат выполняет команду оболочки в сервере
    cmds = [c for c in _commands(rest) if c]
    return TMUX if not cmds or any(c[0] not in READ_ONLY for c in cmds) else None
