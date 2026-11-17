#!/usr/bin/env python3
"""tmux — хозяин сессий Claude Code (OPS-82, PR 2; разбор — docs/integrations/agent-bridge/README.md).

Роли живут окнами одного сервера `tmux -L agents`, а не отдельными окнами Terminal: сессия tmux на продукт, окно на
роль. Владелец видит все роли одним окном (`tmux -L agents attach`); окно, где сессия ждёт ответа, помечено «!» в
строке статуса, `prefix j` — к следующему такому окну.

  tmux_host.py ensure                  сервер отвечает? точно мёртв — поднять (LaunchAgent на Mac, прямой старт на Linux)
                                       под замком; не отвечает, но жив (версии, таймаут) — код 1, сервер не трогается
  tmux_host.py open --product P --name N --cwd DIR --launcher FILE
                                       окно роли с пусковым скриптом spawn_session.sh (другой файл — отказ); stdout:
                                       «<окно> <панель> <tty> <pid панели> <сервер>», второй строкой — команда attach,
                                       если к серверу никто не подключён и attach не просили последние 15 с
  tmux_host.py status-line             пометить окна (@wait: w — ждёт разрешения, i — ждёт задачи) и напечатать сводку
  tmux_host.py next CLIENT WINDOW      к следующему окну, которое ждёт (клавиша prefix j)
  tmux_host.py conf | default-terminal конфиг сервера | терминал по умолчанию (system.terminal в instances/_shared.json)

Сервер — сервис, а не потомок сессии: LaunchAgent space.hrhelper.agents-tmux (`tmux -D`, подъём после сбоя) получает окружение
launchd, а не сессии, которая открыла окно (CLAUDECODE, TAIBE_LINEAGE, CLAUDE_CODE_SSE_PORT и песочница сессии в окна
не попадают); `update-environment` пустой. Панель запускает пусковой скрипт через `<login shell> -l -i -c`, как окно
Terminal: ANTHROPIC_BASE_URL (headroom) и PATH к claude приходят из ~/.zshrc.
Закрывает панель только close_pane() — сторож lineage_retire; CLI для этого нет. Ввод, экран и закрытие окон tmux
агентам запрещает merge-guard (merge_guard_tmux.py).
Тесты: TAIBE_TMUX — подставной tmux, TAIBE_TMUX_SOCKET — имя сервера, TAIBE_TMUX_SERVICE=off — без launchctl,
TAIBE_TMUX_CONF_DIR — папка конфига.
"""
import argparse
import contextlib
import fcntl
import os
import plistlib
import pwd
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import lineage as L  # noqa: E402

LABEL = "space.hrhelper.agents-tmux"
FMT = "#{window_id} #{pane_id} #{pane_tty} #{pane_pid}"
SERVER_FMT = "#{pid}:#{start_time}"
MARKS = ("", "i", "w")  # по возрастанию: окно с двумя панелями берёт старшую метку
STATUS_MARK = {"waiting": "w", "idle": "i"}  # статус ~/.claude/sessions/<pid>.json → метка окна @wait
TERMINALS = ("terminal", "iterm", "tmux", "print")
SERVICE_WAIT = 5.0
ATTACH_GAP = 15.0  # с: окно attach уже попросили — клиент Terminal ещё поднимается, второе окно не открывать
DEAD = ("no server running", "error connecting", "No such file or directory", "Connection refused")


def socket():
    return os.environ.get("TAIBE_TMUX_SOCKET") or "agents"


def tmux_bin():
    return os.environ.get("TAIBE_TMUX") or shutil.which("tmux") or "tmux"


def conf_dir():
    return Path(os.environ.get("TAIBE_TMUX_CONF_DIR") or Path.home() / ".config" / "taibe-agents")


def client_env():
    """Окружение клиента tmux: без TMUX (клиент из окна tmux) и без переменных сессии — сервер их и так не берёт."""
    keep = ("HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMUX_TMPDIR")
    return {k: os.environ[k] for k in keep if k in os.environ}


def tmux(*args):
    try:
        return subprocess.run([tmux_bin(), "-L", socket(), *args], capture_output=True, text=True, env=client_env(),
                              timeout=10)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(args, 127, "", str(exc))


def probe():
    """(«pid:start_time» живого сервера или None, сервера точно нет, ошибка). Сравнение pid:start_time с записью линии
    ловит перезапуск сервера: id панелей после него начинаются заново и достаются другим ролям. «Точно нет» — только
    эти ответы tmux: несовпадение версий клиента и сервера (brew upgrade tmux) и таймаут — живой сервер с ролями."""
    r = tmux("display-message", "-p", SERVER_FMT)
    out = r.stdout.strip()
    if r.returncode == 0 and ":" in out:
        return out, False, ""
    err = (r.stderr or r.stdout).strip()
    return None, r.returncode != 127 and any(m in err for m in DEAD), err


def server_info():
    return probe()[0]


@contextlib.contextmanager
def start_lock():
    """Один старт сервера на машину: второй запуск ждёт первого и видит уже живой сервер."""
    path = conf_dir() / f"{socket()}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def write_private(path, data, mode=0o600):
    """Записать, только если содержимое другое; True — файл изменён."""
    data = data.encode() if isinstance(data, str) else data
    try:
        if path.read_bytes() == data:
            return False
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.chmod(tmp, mode)
    os.replace(tmp, path)
    return True


def layer_tools():
    """eval/tools основного checkout: worktree, из которого подняли сервер, удалят, а строка статуса останется."""
    def git(*a):
        try:
            r = subprocess.run(["git", "-C", str(TOOLS), *a], capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            return ""
        return r.stdout.strip() if r.returncode == 0 else ""
    top, common = git("rev-parse", "--show-toplevel"), git("rev-parse", "--path-format=absolute", "--git-common-dir")
    if top and common:
        main = Path(common).parent / TOOLS.relative_to(Path(top).resolve())
        if (main / "tmux_host.py").is_file():
            return main
    return TOOLS


def conf_text(py, tools):
    run = f"{shlex.quote(py)} -I {shlex.quote(str(tools / 'tmux_host.py'))}"
    mark = "#{?#{==:#{@wait},w},#[fg=red bold]! ,#{?#{==:#{@wait},i},· ,}}"
    return "\n".join([
        "# Сервер сессий Claude — пишет tmux_host.py ensure; правка руками перезапишется.",
        "set -g exit-empty off",
        'set -g update-environment ""',   # окружение клиента (сессии, открывшей окно) в окна не копируется
        "set -g remain-on-exit off",       # пусковой скрипт вышел — панель закрылась сама
        "set -g mouse on",
        # Выделение мышью — сразу в буфер macOS через pbcopy (Terminal.app не принимает OSC 52); Option+перетаскивание —
        # выделение самого Terminal, мимо tmux.
        "set -s set-clipboard external",  # не on: OSC 52 из панели не пишет буфер — сессия не подложит текст владельцу
        'bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"',
        'bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"',
        "set -g history-limit 5000",       # 5–20 МБ на панель в худшем случае (200 колонок, цвет); 12 панелей ≤ 250 МБ
        "set -g base-index 1",
        "set -g allow-rename off",
        "setw -g automatic-rename off",    # имя окна — роль, не то, что пишет claude в заголовок
        "set -g set-titles on",
        'set -g set-titles-string "#S · #W"',
        "set -g status-interval 15",
        "set -g status-right-length 70",
        f'set -g status-right "#({run} status-line)"',
        f'setw -g window-status-format "{mark}#I:#W#[default]"',
        f'setw -g window-status-current-format "#[reverse]{mark}#I:#W#[default]"',
        f"bind-key j run-shell -b \"{run} next '#{{client_name}}' '#{{window_id}}'\"",
        "",
    ])


def plist_bytes(conf):
    exe = shutil.which(tmux_bin()) or tmux_bin()
    path = ":".join(dict.fromkeys([str(Path(exe).parent), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
                                   "/usr/sbin", "/sbin"]))
    lang = os.environ.get("LANG") or ""
    return plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [exe, "-D", "-L", socket(), "-f", str(conf)],
        # Остальное окружение (HOME, SHELL, TMPDIR, SSH_AUTH_SOCK) даёт launchd; переменные сессии сюда не попадают.
        "EnvironmentVariables": {"PATH": path, "LANG": lang if "UTF-8" in lang.upper() else "en_US.UTF-8"},
        # Поднимать снова только после сбоя: `kill-server` владельца — не сбой. Битый конфиг — не чаще 2 раз в минуту.
        "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 30, "ProcessType": "Interactive",
        "StandardErrorPath": str(Path.home() / "Library" / "Logs" / "taibe-agents-tmux.log"),
    })


def plist_path():
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def conf_python(conf):
    """Интерпретатор строки статуса — тот, что уже в конфиге, пока он есть: иначе конфиг менялся бы от вызова к вызову
    (python3 разных PATH) и сервер перечитывал бы его каждый раз."""
    try:
        m = re.search(r"#\((\S+) -I ", conf.read_text(encoding="utf-8"))
    except OSError:
        m = None
    old = shlex.split(m.group(1))[0] if m else ""
    return old if old and os.access(old, os.X_OK) else sys.executable


def start_launchd():
    """Сервер мёртв (probe): загружен — kickstart без -k (живой сервер он не трогает), нет — bootstrap."""
    dom = f"gui/{os.getuid()}"
    loaded = subprocess.run(["launchctl", "print", f"{dom}/{LABEL}"], capture_output=True).returncode == 0
    cmd = ["launchctl", "kickstart", f"{dom}/{LABEL}"] if loaded else ["launchctl", "bootstrap", dom, str(plist_path())]
    subprocess.run(cmd, capture_output=True, timeout=30)


def start_direct(conf):
    """Linux и тесты: сервер уходит в фон сам (tmux демонизируется), окружение — только нужное оболочке."""
    keep = ("HOME", "USER", "LOGNAME", "PATH", "LANG", "SHELL", "TMPDIR", "SSH_AUTH_SOCK")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    try:
        subprocess.run([tmux_bin(), "-L", socket(), "-f", str(conf), "start-server"], env=env, capture_output=True,
                       timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


def ensure():
    if not shutil.which(tmux_bin()):  # без tmux LaunchAgent падал бы и поднимался вечно
        print("tmux_host: tmux не установлен (brew install tmux) — окно Terminal", file=sys.stderr)
        return 1
    conf = conf_dir() / f"{socket()}.conf"
    changed = write_private(conf, conf_text(conf_python(conf), layer_tools()))
    service = os.environ.get("TAIBE_TMUX_SERVICE", "on") != "off" and sys.platform == "darwin" \
        and bool(shutil.which("launchctl"))
    if service:  # правка plist руками или агентом откатывается при каждом вызове
        write_private(plist_path(), plist_bytes(conf))
    info, dead, err = probe()
    if info:
        if changed:
            tmux("source-file", str(conf))
        return 0
    if not dead:  # сервер с ролями жив, но не отвечает этому клиенту — не трогать
        print(f"tmux_host: сервер tmux «{socket()}» не отвечает ({err or 'таймаут'}) — не перезапускаю", file=sys.stderr)
        return 1
    with start_lock():
        if probe()[0]:
            return 0  # пока ждали замок, сервер поднял соседний запуск
        start_launchd() if service else start_direct(conf)
        deadline = time.monotonic() + SERVICE_WAIT
        while time.monotonic() < deadline:
            if server_info():
                return 0
            time.sleep(0.2)
    print(f"tmux_host: сервер tmux «{socket()}» не ответил за {SERVICE_WAIT:.0f} с", file=sys.stderr)
    return 1


def tmux_name(s):
    """Имя сессии или окна tmux: «.» и «:» — разделители цели, пробелы мешают вводу команд."""
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in s)[:40] or "agents"


def attach_cmd(sess):
    # `=имя` — точное совпадение; в кавычках: в zsh слово с `=` в начале раскрывается в путь программы.
    return f"{shlex.quote(tmux_bin())} -L {shlex.quote(socket())} attach -t '={sess}'"


def launcher_ok(path):
    """Пусковой скрипт spawn_session.sh: свой файл 0700 в своей папке claude-spawn.* 0700, вторая строка — снятие
    маркеров сессии. open не запускает произвольную строку: иначе он был бы готовой командой мимо merge-guard."""
    p = Path(path)
    try:
        st, dst = p.stat(), p.parent.stat()
        second = p.read_text(encoding="utf-8").split("\n")[1]
    except (OSError, IndexError, UnicodeDecodeError):
        return False
    own = st.st_uid == dst.st_uid == os.getuid() and not (st.st_mode | dst.st_mode) & 0o077
    return (own and p.is_absolute() and p.parent.name.startswith("claude-spawn.") and p.suffix == ".sh"
            and second == "unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE")


def claim_attach():
    """Окно attach уже открывается (ярлык «ВКЛ»): ближайшие ATTACH_GAP с роли не откроют своё."""
    conf_dir().mkdir(parents=True, exist_ok=True)
    write_private(conf_dir() / f"{socket()}.attach", str(time.time()))


def want_attach():
    """Окно attach: к серверу никто не подключён и его не просили последние ATTACH_GAP с (Terminal и zsh поднимают
    клиента дольше, чем открывается следующая роль, — иначе снова окно на роль)."""
    if tmux("list-clients").stdout.strip():
        return False
    mark = conf_dir() / f"{socket()}.attach"
    try:
        if time.time() - mark.stat().st_mtime < ATTACH_GAP:
            return False
    except OSError:
        pass
    claim_attach()
    return True


def open_window(product, name, cwd, launcher):
    if not launcher_ok(launcher):
        print(f"tmux_host: {launcher} — не пусковой скрипт spawn_session.sh", file=sys.stderr)
        return 2
    if ensure():
        return 1
    sess = tmux_name(product)
    win = tmux_name(name[len(product) + 1:] if name.startswith(product + "-") else name)
    shell = pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"
    run = f"exec {shlex.quote(shell)} -l -i -c {shlex.quote('/bin/bash ' + shlex.quote(launcher))}"
    new_window = ("new-window", "-d", "-P", "-F", FMT, "-t", f"={sess}:", "-n", win, "-c", cwd, run)
    if tmux("has-session", "-t", f"={sess}").returncode == 0:
        r = tmux(*new_window)
    else:
        r = tmux("new-session", "-d", "-P", "-F", FMT, "-s", sess, "-n", win, "-c", cwd, "-x", "200", "-y", "50", run)
        if r.returncode and tmux("has-session", "-t", f"={sess}").returncode == 0:
            r = tmux(*new_window)  # сессию продукта в тот же миг открыл соседний запуск
    parts = r.stdout.split()
    if r.returncode or len(parts) != 4 or not parts[2].startswith("/dev/"):
        if r.returncode == 0 and parts[1:2] and parts[1].startswith("%"):
            tmux("kill-pane", "-t", parts[1])  # окно открылось, но без записи линии его не закрыть — сразу закрыть
        print(f"tmux_host: окно {win} не открыто: {(r.stderr or r.stdout).strip() or r.returncode}", file=sys.stderr)
        return 1
    print(" ".join(parts + [server_info() or "-"]))
    if want_attach():
        print(attach_cmd(sess))
    return 0


def session_status(pid):
    d = L.read_json(L.sessions_dir() / f"{pid}.json")
    return d.get("status") if isinstance(d, dict) else None


def status_line(sx=None):
    """Метки окон по статусу сессий claude на tty их панелей; печать — сводка для status-right."""
    r = tmux("list-panes", "-a", "-F", "#{window_id}\t#{pane_tty}\t#{@wait}")
    if r.returncode:
        return 0
    procs = (sx or L.Sys()).procs()
    by_tty = {}
    for p in procs.values():
        if L.argv0(p) == "claude" and p.tty not in ("", "??", "-"):
            by_tty.setdefault("/dev/" + p.tty, []).append(p.pid)
    wins = {}  # окно → [старая метка, новая]
    for ln in r.stdout.splitlines():
        wid, tty, old = (ln.split("\t") + ["", ""])[:3]
        sts = {STATUS_MARK.get(session_status(pid) or "", "") for pid in by_tty.get(tty, [])}
        new = max(sts | {""}, key=MARKS.index)
        cur = wins.setdefault(wid, [old, ""])
        cur[1] = max(cur[1], new, key=MARKS.index)
    cmds = []
    for wid, (old, new) in wins.items():
        if old != new:
            cmds += ["set-option", "-w", "-t", wid, "@wait", new, ";"]
    if cmds:
        tmux(*cmds[:-1])
    nw = sum(1 for _, n in wins.values() if n == "w")
    ni = sum(1 for _, n in wins.values() if n == "i")
    n = sum(len(by_tty.get(ln.split("\t")[1], [])) for ln in r.stdout.splitlines() if ln.count("\t") >= 1)
    print((f"! {nw} ждут · " if nw else "") + f"{ni} свободны · ролей в tmux {n}")
    return 0


def next_waiting(client, current):
    with open(os.devnull, "w") as quiet:  # метки — свежие, а не 15-секундной давности (0,08 с на нажатие)
        out, sys.stdout = sys.stdout, quiet
        try:
            status_line()
        finally:
            sys.stdout = out
    r = tmux("list-windows", "-a", "-F", "#{window_id}\t#{@wait}")
    rows = [(ln.split("\t") + [""])[:2] for ln in r.stdout.splitlines()]
    order = [w for w, _ in rows]
    for want in ("w", "i"):
        cand = {w for w, m in rows if m == want}
        if cand:
            break
    else:
        tmux("display-message", "-c", client, "никто не ждёт")
        return 0
    k = order.index(current) if current in order else -1
    target = next(w for w in order[k + 1:] + order[:k + 1] if w in cand)
    tmux("switch-client", "-c", client, "-t", target)
    return 0


def close_pane(rec, tty, log):
    """Панель линии rec — только если это она: tty, pid пусковой оболочки и сервер те же, что при открытии (после
    перезапуска сервера id панели достаётся другой роли). Панели нет — успех. True — панели больше нет."""
    rec = rec or {}
    pane = str(rec.get("pane") or "")
    if not pane.startswith("%"):
        log("панель не трогаю: в записи линии нет id панели tmux")
        return False
    # Панель — по списку, не `display-message -t`: на несуществующую панель он отвечает кодом 0 и пустыми полями.
    r = tmux("list-panes", "-a", "-F", "#{pane_id} #{pane_tty} #{pane_pid}")
    rows = {p[0]: p[1:] for p in (ln.split() for ln in r.stdout.splitlines()) if len(p) == 3}
    if pane not in rows:
        log(f"панели {pane} нет — закрывать нечего")
        return True
    got = [*rows[pane], server_info() or "-"]
    want = [str(rec.get("tty") or ""), str(rec.get("pane_pid") or ""), str(rec.get("server") or "")]
    if got != want or tty != want[0]:
        log(f"панель {pane} ({' '.join(got)}) не из записи ({' '.join(want)}, tty сессии {tty}) — не закрываю")
        return False
    k = tmux("kill-pane", "-t", pane)
    log(f"панель {pane} {tty}: " + ("закрыта" if k.returncode == 0 else f"не закрыта ({k.stderr.strip()})"))
    return k.returncode == 0


def default_terminal():
    sys.path.insert(0, str(TOOLS.parent / "nerve"))
    try:
        import products as P
        t = (P.load()[0].get("system") or {}).get("terminal")
    except Exception:  # noqa: BLE001 — копия слоя без instances/
        t = None
    return t if t in TERMINALS else "terminal"


def main(argv=None):
    ap = argparse.ArgumentParser(prog="tmux_host.py", description=(__doc__ or "").split("\n", 1)[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("ensure", "status-line", "conf", "default-terminal"):
        sub.add_parser(name)
    o = sub.add_parser("open")
    o.add_argument("--product", required=True)
    o.add_argument("--name", required=True)
    o.add_argument("--cwd", required=True)
    o.add_argument("--launcher", required=True, help="пусковой скрипт spawn_session.sh (claude-spawn.*/<роль>.sh)")
    n = sub.add_parser("next")
    n.add_argument("client")
    n.add_argument("window")
    a = ap.parse_args(argv)
    if a.cmd == "ensure":
        return ensure()
    if a.cmd == "open":
        return open_window(a.product, a.name, a.cwd, a.launcher)
    if a.cmd == "status-line":
        return status_line()
    if a.cmd == "next":
        return next_waiting(a.client, a.window)
    if a.cmd == "conf":
        print(conf_text(sys.executable, layer_tools()), end="")
        return 0
    print(default_terminal())
    return 0


if __name__ == "__main__":
    sys.exit(main())
