#!/usr/bin/env python3
"""Сервисы сессий одной командой (OPS-82): MCP-хаб, сервер tmux ролей, окна сервисов в tmux, сводка.

  python3 -I eval/tools/agents_up.py            включить разработку: снятые службы, хаб, tmux, окна сервисов, Ollama
  python3 -I eval/tools/agents_up.py --status   только сводка
  python3 -I eval/tools/agents_up.py --down     выключить разработку (спросит, если живы сессии Claude; --yes — нет)
Ярлыки «Разработка ВКЛ/ВЫКЛ» на рабочем столе и автозагрузка — dev_power.py install.

Процессы держит launchd (подъём после сбоя), а не tmux: окна сессии `ops` в сервере `tmux -L agents` только
показывают сервисы — журналы хаба, Нерва и memguard, проверку headroom раз в 15 с. Владелец видит роли и сервисы
в одном окне (`tmux -L agents attach`, `Ctrl-b s` — сессии продуктов и ops), в том числе с телефона по SSH.
Роли не открываются и не снимаются: это spawn_session.sh. Повторный запуск ничего не дублирует.
"""
import argparse
import hashlib
import os
import shlex
import socket as sock
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tmux_host as T  # noqa: E402
import dev_power as D  # noqa: E402
import team_status as TS  # noqa: E402

OPS = "ops"


def hub_script():
    """infra/scripts/dev-ai/mcp-hub.sh основного checkout (хаб обслуживает только его, from_main_only)."""
    f = T.layer_tools().parents[1] / "infra" / "scripts" / "dev-ai" / "mcp-hub.sh"
    return f if f.is_file() else None


def ops_windows():
    """Окно → команда. Только чтение: журналы и проверка порта; процессы сервисов здесь не запускаются."""
    logs = Path.home() / "Library" / "Logs"
    nerve = T.layer_tools().parent / "nerve" / "state" / "nerve.log"
    health = ("while :; do printf '\\033[2J\\033[H'; date '+%H:%M:%S'; "
              "curl -s -m 3 -o /dev/null -w 'headroom :8787 /readyz → %{http_code}\\n' http://127.0.0.1:8787/readyz; "
              "curl -s -m 3 -o /dev/null -w 'MCP-хаб  :3050 /health → %{http_code}\\n' http://127.0.0.1:3050/health; "
              "lsof -nP -iTCP:8787 -sTCP:LISTEN | tail -n +2; sleep 15; done")
    return [("health", health),
            ("hub", f"tail -n 40 -F {shlex.quote(str(logs / 'hr-helper-mcp-hub' / 'hub.log'))}"),
            ("nerve", f"tail -n 40 -F {shlex.quote(str(nerve))}"),
            ("memguard", f"tail -n 40 -F {shlex.quote(str(Path.home() / '.claude' / 'memguard' / 'memguard.err.log'))}")]


def open_ops():
    """Сессия ops с окном на сервис. Окно с этим именем и той же командой не трогается (повторный запуск не множит
    окна); с другой командой (пути сменились после мёржа) — перезапускается на месте."""
    # Команду окна tmux хранит с экранированием — сравнивается хеш в опции окна @cmd.
    out = T.tmux("list-windows", "-t", f"={OPS}", "-F", "#{window_id}\t#{window_name}\t#{@cmd}").stdout
    have = {r[1]: (r[0], r[2]) for r in (ln.split("\t") for ln in out.splitlines()) if len(r) == 3}
    shell = shlex.quote(os.environ.get("SHELL") or "/bin/zsh")
    for name, cmd in ops_windows():
        run = f"exec {shell} -l -c {shlex.quote(cmd)}"
        tag = hashlib.sha1(run.encode()).hexdigest()[:12]
        if name in have:
            wid, old = have[name]
            if old != tag:
                T.tmux("respawn-window", "-k", "-t", wid, run)
                T.tmux("set-option", "-w", "-t", wid, "@cmd", tag)
            continue
        fmt = ("-P", "-F", "#{window_id}")
        if T.tmux("has-session", "-t", f"={OPS}").returncode == 0:
            r = T.tmux("new-window", "-d", *fmt, "-t", f"={OPS}:", "-n", name, run)
        else:
            r = T.tmux("new-session", "-d", *fmt, "-s", OPS, "-n", name, "-x", "200", "-y", "50", run)
        if r.returncode == 0 and r.stdout.strip():
            T.tmux("set-option", "-w", "-t", r.stdout.strip(), "@cmd", tag)


def port_open(port):
    with sock.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def loaded(label):
    return subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"], capture_output=True).returncode == 0


def summary():
    # headroom не ставится отсюда: переключение снимает процесс на :8787 — это решение, а не подъём (install).
    hr = "python3 -I infra/headroom/developer/headroom_launchd.py " + (
        "status" if loaded("space.hrhelper.headroom") else "install — сейчас не под launchd")
    rows = [("сервер tmux ролей", T.server_info() is not None, f"tmux -L {T.socket()} attach"),
            ("MCP-хаб :3050", port_open(3050), "infra/scripts/dev-ai/mcp-hub.sh status"),
            ("headroom :8787", port_open(8787) and loaded("space.hrhelper.headroom"), hr),
            ("Нерв", loaded("space.hrhelper.nerve"), "spawn_session.sh --status")]
    for name, ok, hint in rows:
        print(f"  {'✓' if ok else '✗'} {name:<20} {hint}")
    wins = T.tmux("list-windows", "-a", "-F", "#{session_name}").stdout.split()
    print(f"  окна: ролей {sum(1 for s in wins if s != OPS)}, сервисов {wins.count(OPS)}")
    return 0 if all(ok for _, ok, _ in rows) else 1


def mem():
    free = TS.Sys().mem_free()
    return "—" if free is None else f"{free}%"


def down(yes):
    """Выключить разработку (dev_power): живые сессии Claude теряют API и MCP — спросить, если они есть."""
    n = TS.live_sessions(TS.Sys())
    roles = sum(1 for s in T.tmux("list-windows", "-a", "-F", "#{session_name}").stdout.split() if s != OPS)
    if (n or roles) and not yes:
        print(f"Живых сессий Claude: {n}, ролей в tmux: {roles}. Выключение закроет роли в tmux, остальные сессии "
              "останутся без API (headroom) и MCP.")
        if not sys.stdin.isatty():
            print("не из терминала — нужен --yes")
            return 2
        if input("Выключить разработку? [y/N] ").strip().lower() not in ("y", "yes", "д", "да"):
            print("отменено")
            return 1
    before = mem()
    D.agents_off(print)
    hub = hub_script()
    if hub:
        subprocess.run(["bash", str(hub), "stop"], cwd=str(hub.parents[3]), timeout=120,
                       stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        print("  ✓ хаб MCP и serena остановлены")
    D.apps_off(print)
    print(f"Разработка выключена. Свободно памяти: {before} → {mem()}. Остались: memguard, резервные копии, WireGuard. "
          "Включить — «Разработка ВКЛ» на рабочем столе или вход в систему.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="agents_up.py", description=(__doc__ or "").split("\n", 1)[0])
    ap.add_argument("--status", action="store_true", help="только сводка")
    ap.add_argument("--down", action="store_true", help="выключить разработку (dev_power.py)")
    ap.add_argument("--yes", action="store_true", help="с --down: не спрашивать про живые сессии")
    a = ap.parse_args(argv)
    if a.down:
        return down(a.yes)
    if not a.status:
        D.agents_on(print)  # снятые «ВЫКЛ» службы — обратно (headroom первым)
        hub = hub_script()
        if hub and not port_open(3050):
            subprocess.run(["bash", str(hub), "start"], cwd=str(hub.parents[3]), timeout=300)
        if T.ensure():
            return 1
        open_ops()
        D.apps_on(print)
    return summary()


if __name__ == "__main__":
    sys.exit(main())
