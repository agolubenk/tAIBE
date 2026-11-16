#!/usr/bin/env python3
"""Разработка на Mac: включить, выключить, ярлыки и автозагрузка (OPS-82, владелец 16.11).

Включить (`agents_up.py`, ярлык «Разработка ВКЛ», вход в систему): службы launchd из system.dev.agents
(instances/_shared.json) загружаются, если их сняли; сервер tmux ролей и окна сервисов; приложения
system.dev.apps_on (Ollama); последним — хаб MCP, если молчит. Docker не запускается — он для тестов.
Выключить (`agents_up.py --down`, ярлык «Разработка ВЫКЛ»): ждёт конца git и evolve; те же службы снимаются
(launchctl bootout — до «ВКЛ» или следующего входа), хаб и serena останавливаются, приложения system.dev.apps_off
закрываются (Docker — только без работающих контейнеров или с подтверждением). Остаются memguard, резервные копии,
WireGuard и то, что запущено руками: сессии Claude вне tmux, claude-mem, VS Code — их список с памятью печатается.
Роли в tmux закрываются; их список сохраняется, «ВКЛ» печатает команду, чтобы поднять их снова.
Код при входе — из основного checkout (как Нерв и хуки): доверие то же.

  python3 -I eval/tools/dev_power.py install     ярлыки на рабочем столе и автозагрузка (space.hrhelper.dev-up)
  python3 -I eval/tools/dev_power.py uninstall   убрать ярлыки и автозагрузку (службы не трогаются)
"""
import os
import plistlib
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import tmux_host as T  # noqa: E402

LABEL_UP = "space.hrhelper.dev-up"
DESKTOP_ON, DESKTOP_OFF = "Разработка ВКЛ.command", "Разработка ВЫКЛ.command"
FIRST = "space.hrhelper.headroom"  # включение: сначала API сессий; выключение — он последним
LABEL_RE = re.compile(r"space\.hrhelper\.[a-z0-9-]+")
APPS = {"com.electron.ollama": "Ollama", "com.docker.docker": "Docker"}  # config только выбирает из них
WAIT_BUSY = 30  # с: ждать конца git и evolve перед выключением


def home():
    custom = os.environ.get("TAIBE_DEV_HOME") if os.environ.get("TAIBE_DEV_TEST") == "1" else None
    return Path(custom or Path.home())


def config():
    sys.path.insert(0, str(TOOLS.parent / "nerve"))
    try:
        import products as P
        dev = (P.load()[0].get("system") or {}).get("dev") or {}
    except Exception as exc:  # noqa: BLE001 — копия слоя без instances/
        print(f"dev_power: system.dev не прочитан ({exc.__class__.__name__}) — службы не трогаю", file=sys.stderr)
        dev = {}
    agents = [a for a in dev.get("agents") or [] if isinstance(a, str) and LABEL_RE.fullmatch(a)]
    agents.sort(key=lambda a: a != FIRST)
    apps = [[b for b in dev.get(k) or [] if b in APPS] for k in ("apps_on", "apps_off")]
    return agents, apps[0], apps[1]


def run(*cmd, timeout=60):
    try:
        return subprocess.run(list(cmd), capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(cmd, 124, "", str(exc))


def domain():
    return f"gui/{os.getuid()}"


def plist(label):
    return home() / "Library" / "LaunchAgents" / f"{label}.plist"


def loaded(label):
    return run("launchctl", "print", f"{domain()}/{label}").returncode == 0


def plist_ok(label):
    """Свой plist: владелец — этот пользователь, не пишется группой и другими, Label = имя файла."""
    p = plist(label)
    try:
        st = p.stat()
        lab = plistlib.loads(p.read_bytes()).get("Label")
    except (OSError, ValueError, plistlib.InvalidFileException):
        return False
    return st.st_uid == os.getuid() and not st.st_mode & 0o022 and lab == label


def agents_on(log):
    ok = True
    for label in config()[0]:
        if loaded(label):
            continue
        if not plist_ok(label):
            log(f"  · {label}: нет своего plist — пропускаю")
            continue
        r = run("launchctl", "bootstrap", domain(), str(plist(label)))
        ok = ok and r.returncode == 0
        log(f"  {'✓' if r.returncode == 0 else '✗'} {label} загружена" + ("" if r.returncode == 0 else f": {r.stderr.strip()}"))
    return ok


def agents_off(log):
    for label in reversed(config()[0]):
        if loaded(label):
            r = run("launchctl", "bootout", f"{domain()}/{label}")
            log(f"  {'✓' if r.returncode == 0 else '✗'} {label} снята" + ("" if r.returncode == 0 else f": {r.stderr.strip()}"))


def osa(script, bundle, timeout=60):
    """AppleScript с bundle id аргументом, не в тексте скрипта."""
    return run("osascript", "-e", "on run argv", "-e", script, "-e", "end run", bundle, timeout=timeout)


def app_running(bundle):
    return osa("return (application id (item 1 of argv) is running) as text", bundle, 15).stdout.strip() == "true"


def apps_on(log):
    for b in config()[1]:
        if not app_running(b):
            r = run("open", "-g", "-b", b)
            log(f"  {'✓' if r.returncode == 0 else '✗'} {APPS[b]} запущено")


def docker_busy():
    r = run("docker", "ps", "-q", timeout=15)
    return r.returncode == 0 and bool(r.stdout.strip())


def apps_off(log, ask):
    for b in config()[2]:
        if not app_running(b):
            continue
        if b == "com.docker.docker" and docker_busy() and not ask("В Docker работают контейнеры (тесты, стенд HR) — закрыть Docker?"):
            log("  · Docker оставлен: работают контейнеры")
            continue
        osa("tell application id (item 1 of argv) to quit", b)
        gone = any(not app_running(b) or time.sleep(1) for _ in range(10))
        log(f"  {'✓' if gone else '✗'} {APPS[b]} " + ("закрыто" if gone else "не закрылось — закройте вручную"))


def busy():
    """Процессы, которые нельзя рвать: git (index.lock) и ночной evolve."""
    r = run("pgrep", "-fl", r"(^|/)git( |$)|evolve/daily\.py")
    return [ln for ln in r.stdout.splitlines() if ln.strip()]


def wait_quiet(log):
    for _ in range(WAIT_BUSY):
        b = busy()
        if not b:
            return []
        time.sleep(1)
    log(f"  ждал {WAIT_BUSY} с, работают: " + "; ".join(x[:80] for x in busy()))
    return busy()


def roles_file():
    return T.conf_dir() / "roles-before-off.txt"


def save_roles():
    """Окна ролей (не ops) → файл: «ВКЛ» напомнит, какие роли поднять."""
    out = T.tmux("list-windows", "-a", "-F", "#{session_name} #{window_name}").stdout.split("\n")
    roles = [ln for ln in out if ln.strip() and not ln.startswith("ops ")]
    if roles:
        roles_file().parent.mkdir(parents=True, exist_ok=True)
        roles_file().write_text("\n".join(roles) + "\n", encoding="utf-8")
    return roles


def roles_hint():
    """Команды spawn_session.sh для ролей, закрытых «ВЫКЛ»; файл читается один раз."""
    try:
        rows = [ln.split() for ln in roles_file().read_text(encoding="utf-8").splitlines() if ln.strip()]
        roles_file().unlink()
    except OSError:
        return []
    by = {}
    for product, win in (r for r in rows if len(r) == 2):
        by.setdefault(product, []).append(re.sub(r"-[a-z0-9]{4}$", "", win))
    return [f"bash eval/tools/spawn_session.sh --launch --product {p} --roles {','.join(dict.fromkeys(r))}"
            for p, r in by.items()]


def leftovers():
    """Что осталось после «ВЫКЛ» (запущено руками): имя → (число, МБ)."""
    r = run("ps", "-axo", "rss=,command=")
    groups = {"сессии Claude": r"(^|/)claude( |$)", "claude-mem": r"claude-mem|chroma-mcp",
              "VS Code": r"Visual Studio Code|Code Helper"}
    out = {}
    for ln in r.stdout.splitlines():
        rss, _, cmd = ln.strip().partition(" ")
        for name, pat in groups.items():
            if rss.isdigit() and re.search(pat, cmd):
                n, mb = out.get(name, (0, 0))
                out[name] = (n + 1, mb + int(rss) // 1024)
                break
    return out


def python():
    """Интерпретатор для ярлыков и входа: не из venv (его могут удалить)."""
    if sys.prefix != sys.base_prefix:
        base = Path(sys.base_prefix) / "bin" / "python3"
        if base.exists():
            return str(base)
    return sys.executable if os.path.isabs(sys.executable) else "/usr/bin/python3"


def desktop_text(down):
    up = T.layer_tools() / "agents_up.py"
    return "\n".join([
        "#!/bin/zsh",
        "# Пишет eval/tools/dev_power.py install — правка руками перезапишется.",
        f"echo 'Разработка: {'выключаю' if down else 'включаю'}…'",
        f"{shlex.quote(python())} -I {shlex.quote(str(up))}" + (" --down" if down else ""),
        "echo; echo 'Готово — окно можно закрыть.'",
        "",
    ])


def up_plist():
    path = ":".join(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
                     str(home() / ".local" / "bin")])
    log = str(home() / "Library" / "Logs" / "taibe-dev-up.log")
    return plistlib.dumps({
        "Label": LABEL_UP,
        "ProgramArguments": [python(), "-I", str(T.layer_tools() / "agents_up.py")],
        "EnvironmentVariables": {"PATH": path, "LANG": "en_US.UTF-8"},
        "RunAtLoad": True,  # один раз при входе; сами службы держит launchd
        "StandardOutPath": log, "StandardErrorPath": log,
    })


def write(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data if isinstance(data, bytes) else data.encode())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def install(log=print):
    desk = home() / "Desktop"
    write(desk / DESKTOP_ON, desktop_text(False), 0o755)
    write(desk / DESKTOP_OFF, desktop_text(True), 0o755)
    log(f"ярлыки: «{DESKTOP_ON}», «{DESKTOP_OFF}» на рабочем столе")
    write(plist(LABEL_UP), up_plist(), 0o600)
    if loaded(LABEL_UP):
        run("launchctl", "bootout", f"{domain()}/{LABEL_UP}")
    r = run("launchctl", "bootstrap", domain(), str(plist(LABEL_UP)), timeout=300)
    log(f"автозагрузка {LABEL_UP}: " + ("при каждом входе (и сейчас)" if r.returncode == 0 else r.stderr.strip()))
    return 0 if r.returncode == 0 else 1


def uninstall(log=print):
    run("launchctl", "bootout", f"{domain()}/{LABEL_UP}")
    for p in (plist(LABEL_UP), home() / "Desktop" / DESKTOP_ON, home() / "Desktop" / DESKTOP_OFF):
        p.unlink(missing_ok=True)
    log("ярлыки и автозагрузка убраны; службы не тронуты")
    return 0


def main(argv):
    if len(argv) != 2 or argv[1] not in ("install", "uninstall"):
        print((__doc__ or "").split("\n\n")[-1], file=sys.stderr)
        return 2
    return install() if argv[1] == "install" else uninstall()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
