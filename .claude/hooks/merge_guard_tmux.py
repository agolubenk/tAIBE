"""
merge-guard: окна сессий в tmux (OPS-82). Роли Claude живут окнами одного сервера tmux (eval/tools/tmux_host.py):
`send-keys` в окно Контроля — тот же обход «вливает только Контроль», что ввод от имени владельца; `capture-pane`,
буферы и поиск по экрану (`#{C:…}`) читают чужой экран; `#(…)`, `#{E:…}` (формат из заголовка панели, который пишет
сама панель), `run-shell`, `if-shell`, `-c`, `-f` и хуки выполняют команду в сервере мимо разбора этого хука.
Агенту — только чтение списков с простыми переменными формата; остальное — руками владельца, Контролю тоже нет.
Окна открывает spawn_session.sh (tmux_host.py open берёт только его пусковой скрипт), закрывает сторож retire.
Подкоманды — по списку разрешённых: сокращение (`send` → send-keys) и псевдоним вне списка — тоже отказ.
"""
import re

TMUX = "ввод, экран или управление окнами сессий в tmux (OPS-82)"
READ_ONLY = {"list-sessions", "ls", "list-windows", "lsw", "list-panes", "lsp", "list-clients", "lsc", "has-session",
             "has", "display-message", "display", "show-options", "show", "show-window-options", "showw"}
GLOBAL_VALUED = {"L"}  # -L имя сервера; -S, -f (конфиг с хуками), -T — отказ
GLOBAL_BOOL = set("2uVNl")  # -C (команды из stdin), -c (команда оболочки), -D (сервер), -v (журнал в cwd) — отказ
DISPLAY_DENY = set("aIv")  # display -a печатает все переменные (и pane_start_command), -I пишет stdin в панель
# Переменные формата, которые агенту можно читать: имена и номера, без содержимого экрана и команд панелей.
SAFE_VARS = {"session_name", "session_id", "window_id", "window_index", "window_name", "window_active", "pane_id",
             "pane_index", "pane_tty", "pane_pid", "pane_active", "pane_dead", "client_name", "client_tty", "pid",
             "start_time", "version", "@wait"}
FORMAT = re.compile(r"(?:[^#]|##|#\{([\w@]+)\})*")
# `tmux lsw \; send-keys …`: разбор shell в хуке делит команду и по `\;` — хвост цепочки приходит отдельной командой с
# именем подкоманды tmux. Программ с такими именами нет: отказ по имени. Только однозначные — без `run`, `source`, `at`,
# `new`, `a`, `if`: это настоящие команды и встроенные shell.
CHAIN_TAIL = {"send-keys", "send", "send-prefix", "capture-pane", "capturep", "pipe-pane", "pipep", "kill-pane", "killp",
              "kill-window", "killw", "kill-session", "kill-server", "respawn-pane", "respawnp", "respawn-window",
              "respawnw", "run-shell", "if-shell", "set-hook", "source-file", "new-window", "neww", "split-window",
              "splitw", "new-session", "attach-session", "paste-buffer", "pasteb", "load-buffer", "loadb", "set-buffer",
              "setb", "show-buffer", "showb", "save-buffer", "saveb", "set-option", "set-window-option", "setw",
              "set-environment", "setenv", "show-environment", "showenv", "command-prompt", "display-popup", "popup",
              "bind-key", "unbind-key"}


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


def _safe_format(w):
    """Слово без `#` или формат только из простых переменных SAFE_VARS (без модификаторов E:, C:, ?, =, s/…)."""
    m = FORMAT.fullmatch(w)
    return "#" not in w or (m is not None and all(v in SAFE_VARS for v in re.findall(r"#\{([\w@]+)\}", w)))


def _read_only(c):
    if c[0] not in READ_ONLY or not all(_safe_format(w) for w in c[1:]):
        return False
    if c[0] in ("display-message", "display"):
        return not any(w.startswith("-") and set(w[1:]) & DISPLAY_DENY for w in c[1:])
    return True


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
    cmds = [c for c in _commands(rest) if c]
    return TMUX if not cmds or not all(_read_only(c) for c in cmds) else None
