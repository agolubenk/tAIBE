#!/usr/bin/env python3
"""Сервисы сессий одной командой (OPS-82): MCP-хаб, сервер tmux ролей, окна сервисов в tmux, сводка.

  python3 -I eval/tools/agents_up.py            включить разработку: службы, хаб, tmux, окна сервисов, Ollama, роли
  python3 -I eval/tools/agents_up.py --attach   то же, роли — в фоне, а это окно Terminal — окно ролей (ярлык «ВКЛ»)
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
import time
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tmux_host as T  # noqa: E402
import dev_power as D  # noqa: E402
import team_status as TS  # noqa: E402
import team_plan as TP  # noqa: E402

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
    agents, apps_on, _ = D.config()
    rows = [("сервер tmux ролей", T.server_info() is not None, f"tmux -L {T.socket()} attach"),
            ("MCP-хаб :3050", port_open(3050), "infra/scripts/dev-ai/mcp-hub.sh status"),
            ("headroom :8787", port_open(8787) and loaded("space.hrhelper.headroom"), hr),
            ("Нерв", loaded("space.hrhelper.nerve"), "spawn_session.sh --status")]
    rest = [a for a in agents if a not in ("space.hrhelper.headroom", "space.hrhelper.agents-tmux",
                                           "space.hrhelper.nerve")]
    rows += [(a.split(".")[-1], loaded(a), "launchctl print gui/$(id -u)/" + a) for a in rest]
    rows += [(D.APPS[b], D.app_running(b), f"open -b {b}") for b in apps_on]
    for name, ok, hint in rows:
        print(f"  {'✓' if ok else '✗'} {name:<24} {hint}")
    print("  · Docker не запускается (тесты) — открыть вручную")
    wins = T.tmux("list-windows", "-a", "-F", "#{session_name}").stdout.split()
    print(f"  окна: ролей {sum(1 for s in wins if s != OPS)}, сервисов {wins.count(OPS)}")
    return 0 if all(ok for _, ok, _ in rows) else 1


def mem():
    free = TS.Sys().mem_free()
    return "—" if free is None else f"{free}%"


def hub_cmd(verb, timeout):
    """mcp-hub.sh start|stop; таймаут не обрывает остальное включение и выключение."""
    hub = hub_script()
    if not hub:
        return False
    try:
        r = subprocess.run(["bash", str(hub), verb], cwd=str(hub.parents[3]), timeout=timeout,
                           stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    except subprocess.TimeoutExpired:
        print(f"  ✗ хаб MCP: {verb} дольше {timeout} с — infra/scripts/dev-ai/mcp-hub.sh status")
        return False
    return r.returncode == 0


def down(yes):
    """Выключить разработку (dev_power): что закроется и что останется — до вопроса."""
    def ask(q):
        if yes:
            return True
        if not sys.stdin.isatty():
            print(f"{q} — не из терминала, нужен --yes")
            return False
        return input(f"{q} [y/N] ").strip().lower() in ("y", "yes", "д", "да")

    n = TS.live_sessions(TS.Sys())
    roles = [w for w in T.tmux("list-windows", "-a", "-F", "#{session_name}:#{window_name}").stdout.split()
             if not w.startswith(OPS + ":")]
    print("Будет закрыто: " + (f"роли в tmux ({', '.join(roles)}), " if roles else "")
          + "headroom, хаб MCP и serena, Нерв, службы досок, Docker, Ollama.")
    if n:
        print(f"Сессий Claude сейчас: {n}. Те, что вне tmux, не закроются: они держат память и до «ВКЛ» останутся "
              "без API (headroom) и MCP. Роли «ВКЛ» откроет снова по плану команды (12, доли — из очереди).")
    if (n or roles) and not ask("Выключить разработку?"):
        print("отменено")
        return 1
    if D.wait_quiet(print) and not ask("Работают git или evolve — выключить всё равно?"):
        print("отменено")
        return 1
    before = mem()
    D.agents_off(print)  # первым снимается сторож команды — он не откроет роли заново
    stopped = hub_cmd("stop", 120) and not port_open(3050)
    print(f"  {'✓' if stopped else '✗'} хаб MCP и serena " + ("остановлены" if stopped else "не остановились"))
    D.apps_off(print, ask)
    time.sleep(3)  # Docker и Ollama отдают память не сразу
    print(f"Разработка выключена. Свободно памяти: {before} → {mem()}.")
    left = D.leftovers()
    if left:
        print("Осталось (запущено руками): " + ", ".join(f"{k} {n} шт. ~{mb} МБ" for k, (n, mb) in left.items())
              + ". Для кино закройте их сами.")
    print("Остались службы: memguard, резервные копии, WireGuard. Включить — «Разработка ВКЛ» или вход в систему.")
    return 0


def team_bg():
    """Команда ролей в фоне (ярлык «ВКЛ»): окно сразу становится окном tmux, роли появляются в нём по мере открытия.
    Журнал — тот же, что у сторожа; запуск, заставший сторожа за работой, выходит по замку team.lock."""
    log = D.home() / "Library" / "Logs" / "taibe-team.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "a", encoding="utf-8") as out:
        subprocess.Popen([sys.executable, "-I", "-u", str(Path(__file__).resolve().parent / "team_plan.py"), "up"],
                         stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    print(f"  роли открываются в фоне — появятся окнами tmux; журнал: {log}")


def attach(ok):
    """Это окно Terminal становится окном ролей (`tmux -L agents attach`). Сводка с ✗ — сначала Enter: иначе tmux
    закроет её экраном ролей. Возврат — только если окно ролей не открыть; тогда ярлык допечатает «Готово»."""
    if T.server_info() is None:
        print("  сервер tmux не отвечает — окно ролей не открыть; роли откроются окнами Terminal")
        return 1
    if os.environ.get("TMUX"):
        print("  это окно уже внутри tmux: роли — Ctrl-b s")
        return 0
    if not ok and sys.stdin.isatty():
        input("  выше ✗ — что не поднялось. Enter — открыть окно ролей: ")
    print("  окно ролей: Ctrl-b s — продукты, Ctrl-b w — роли, Ctrl-b d — отключиться (роли продолжат работу)")
    cmd = [T.tmux_bin(), "-L", T.socket(), "attach"]
    try:
        os.execvp(cmd[0], cmd)
    except OSError as exc:
        print(f"  окно ролей не открылось ({exc.__class__.__name__}): {' '.join(cmd)}")
    return 1


def main(argv=None):
    ap = argparse.ArgumentParser(prog="agents_up.py", description=(__doc__ or "").split("\n", 1)[0])
    ap.add_argument("--status", action="store_true", help="только сводка")
    ap.add_argument("--down", action="store_true", help="выключить разработку (dev_power.py)")
    ap.add_argument("--yes", action="store_true", help="с --down: не спрашивать про живые сессии")
    ap.add_argument("--no-team", action="store_true", help="только службы, без команды ролей")
    ap.add_argument("--attach", action="store_true", help="роли в фоне, затем это окно — окно ролей tmux (ярлык «ВКЛ»)")
    a = ap.parse_args(argv)
    if a.down:
        return down(a.yes)
    if not a.status:
        D.agents_on(print)  # снятые «ВЫКЛ» службы — обратно (headroom первым)
        if T.ensure() == 0:
            open_ops()
        D.apps_on(print)
        if not port_open(3050):  # последним: старт хаба с serena — до минуты, остальное его не ждёт
            hub_cmd("start", 300)
        D.trim_log("taibe-dev-up.log")
        D.trim_log("taibe-team.log")
        if a.attach and not a.no_team:
            T.claim_attach()  # роль, открытая до подключения окна, не откроет второе окно Terminal
            team_bg()
        elif not a.no_team:
            TP.up(log=print)  # роли по продуктам: 12 (доли — из очереди владельца), при нехватке памяти — 10
    rc = summary()
    return attach(rc == 0) if a.attach and not a.status else rc


if __name__ == "__main__":
    sys.exit(main())
