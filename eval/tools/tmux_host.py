#!/usr/bin/env python3
"""tmux — хозяин сессий Claude Code (OPS-82, PR 2; разбор — docs/integrations/agent-bridge/README.md).

Роли живут окнами одного сервера `tmux -L agents`, а не отдельными окнами Terminal: сессия tmux на продукт, окно на
роль. Владелец видит все роли одним окном (`tmux -L agents attach`); окно, где сессия ждёт ответа, помечено «!» в
строке статуса, `prefix j` — к следующему такому окну.

  tmux_host.py ensure                  сервер отвечает? нет — LaunchAgent (Mac) или прямой старт (Linux); код 0 — жив
  tmux_host.py open --product P --name N --cwd DIR -- CMD
                                       окно роли; stdout: «<окно> <панель> <tty> <pid панели> <сервер>», второй строкой —
                                       команда attach, если к серверу ещё никто не подключён
  tmux_host.py status-line             пометить окна (@wait: w — ждёт разрешения, i — ждёт задачи) и напечатать сводку
  tmux_host.py next CLIENT WINDOW      к следующему окну, которое ждёт (клавиша prefix j)
  tmux_host.py conf | default-terminal конфиг сервера | терминал по умолчанию (system.terminal в instances/_shared.json)

Сервер — сервис, а не потомок сессии: LaunchAgent space.hrhelper.agents-tmux (`tmux -D`, KeepAlive) получает окружение
launchd, а не сессии, которая открыла окно (CLAUDECODE, TAIBE_LINEAGE, CLAUDE_CODE_SSE_PORT и песочница сессии в окна
не попадают); `update-environment` пустой. Панель запускает пусковой скрипт через `<login shell> -l -i -c`, как окно
Terminal: ANTHROPIC_BASE_URL (headroom) и PATH к claude приходят из ~/.zshrc.
Закрывает панель только close_pane() — сторож lineage_retire; CLI для этого нет. Ввод, экран и закрытие окон tmux
агентам запрещает merge-guard (merge_guard_tmux.py).
Тесты: TAIBE_TMUX — подставной tmux, TAIBE_TMUX_SOCKET — имя сервера, TAIBE_TMUX_SERVICE=off — без launchctl,
TAIBE_TMUX_CONF_DIR — папка конфига.
"""
import argparse
import os
import plistlib
import pwd
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


def server_info():
    """«pid:start_time» живого сервера или None. Сравнение с записью линии ловит перезапуск сервера: id панелей
    после него начинаются заново и достаются другим ролям."""
    r = tmux("display-message", "-p", SERVER_FMT)
    out = r.stdout.strip()
    return out if r.returncode == 0 and ":" in out else None


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
        "set -g history-limit 5000",       # ≈ 1–2 МБ на панель; 12 панелей — десятки МБ, не сотни
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
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10, "ProcessType": "Interactive",
        "StandardErrorPath": str(Path.home() / "Library" / "Logs" / "taibe-agents-tmux.log"),
    })


def start_launchd(conf):
    plist = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    write_private(plist, plist_bytes(conf), mode=0o644)
    dom = f"gui/{os.getuid()}"
    loaded = subprocess.run(["launchctl", "print", f"{dom}/{LABEL}"], capture_output=True).returncode == 0
    cmd = ["launchctl", "kickstart", "-k", f"{dom}/{LABEL}"] if loaded else ["launchctl", "bootstrap", dom, str(plist)]
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
    conf = conf_dir() / f"{socket()}.conf"
    changed = write_private(conf, conf_text(sys.executable, layer_tools()))
    if server_info():
        if changed:
            tmux("source-file", str(conf))
        return 0
    service = os.environ.get("TAIBE_TMUX_SERVICE", "on") != "off"
    if service and sys.platform == "darwin" and shutil.which("launchctl"):
        start_launchd(conf)
    else:
        start_direct(conf)
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


def open_window(product, name, cwd, cmd):
    if ensure():
        return 1
    sess = tmux_name(product)
    win = tmux_name(name[len(product) + 1:] if name.startswith(product + "-") else name)
    shell = pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"
    run = f"exec {shlex.quote(shell)} -l -i -c {shlex.quote(cmd)}"
    new_window = ("new-window", "-d", "-P", "-F", FMT, "-t", f"={sess}:", "-n", win, "-c", cwd, run)
    if tmux("has-session", "-t", f"={sess}").returncode == 0:
        r = tmux(*new_window)
    else:
        r = tmux("new-session", "-d", "-P", "-F", FMT, "-s", sess, "-n", win, "-c", cwd, "-x", "200", "-y", "50", run)
        if r.returncode and tmux("has-session", "-t", f"={sess}").returncode == 0:
            r = tmux(*new_window)  # сессию продукта в тот же миг открыл соседний запуск
    parts = r.stdout.split()
    if r.returncode or len(parts) != 4 or not parts[2].startswith("/dev/"):
        print(f"tmux_host: окно {win} не открыто: {(r.stderr or r.stdout).strip() or r.returncode}", file=sys.stderr)
        return 1
    print(" ".join(parts + [server_info() or "-"]))
    if not tmux("list-clients").stdout.strip():
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
    print((f"! {nw} ждут · " if nw else "") + f"{ni} свободны · claude {sum(map(len, by_tty.values()))}")
    return 0


def next_waiting(client, current):
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
    o.add_argument("command", nargs=argparse.REMAINDER, help="-- CMD: строка команды пускового скрипта")
    n = sub.add_parser("next")
    n.add_argument("client")
    n.add_argument("window")
    a = ap.parse_args(argv)
    if a.cmd == "ensure":
        return ensure()
    if a.cmd == "open":
        cmd = a.command[1:] if a.command[:1] == ["--"] else a.command
        if len(cmd) != 1:
            ap.error("open: после -- — одна строка команды")
        return open_window(a.product, a.name, a.cwd, cmd[0])
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
