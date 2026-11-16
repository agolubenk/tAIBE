#!/usr/bin/env python3
"""Разработка на Mac: включить, выключить, ярлыки и автозагрузка (OPS-82, владелец 16.11).

Включить (`agents_up.py`, ярлык «Разработка ВКЛ», вход в систему): службы launchd из system.dev.agents
(instances/_shared.json) загружаются, если их сняли; хаб MCP поднимается, если молчит; сервер tmux ролей и окна
сервисов; приложения system.dev.apps_on (Ollama). Docker не запускается — он для тестов.
Выключить (`agents_up.py --down`, ярлык «Разработка ВЫКЛ»): те же службы снимаются (launchctl bootout — до
следующего входа или «ВКЛ»), хаб и serena останавливаются, приложения system.dev.apps_off закрываются (Docker,
Ollama). Остаются memguard, резервные копии и WireGuard. Живые сессии Claude теряют API (headroom) и MCP, роли в
tmux закрываются — поэтому при них выключение спрашивает подтверждение.

  python3 -I eval/tools/dev_power.py install     ярлыки на рабочем столе и автозагрузка (space.hrhelper.dev-up)
  python3 -I eval/tools/dev_power.py uninstall   убрать ярлыки и автозагрузку (службы не трогаются)
"""
import os
import plistlib
import shlex
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import tmux_host as T  # noqa: E402

LABEL_UP = "space.hrhelper.dev-up"
DESKTOP_ON, DESKTOP_OFF = "Разработка ВКЛ.command", "Разработка ВЫКЛ.command"
# Порядок включения: сначала API сессий (headroom), потом всё остальное; выключение — в обратном порядке.
FIRST = "space.hrhelper.headroom"


def home():
    return Path(os.environ.get("TAIBE_DEV_HOME") or Path.home())


def config():
    sys.path.insert(0, str(TOOLS.parent / "nerve"))
    try:
        import products as P
        dev = (P.load()[0].get("system") or {}).get("dev") or {}
    except Exception:  # noqa: BLE001 — копия слоя без instances/
        dev = {}
    agents = [a for a in dev.get("agents") or [] if isinstance(a, str) and a.startswith("space.hrhelper.")]
    agents.sort(key=lambda a: a != FIRST)
    return agents, list(dev.get("apps_on") or []), list(dev.get("apps_off") or [])


def run(*cmd, timeout=60):
    try:
        return subprocess.run(list(cmd), capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(cmd, 127, "", str(exc))


def domain():
    return f"gui/{os.getuid()}"


def plist(label):
    return home() / "Library" / "LaunchAgents" / f"{label}.plist"


def loaded(label):
    return run("launchctl", "print", f"{domain()}/{label}").returncode == 0


def agents_on(log):
    agents = config()[0]
    for label in agents:
        if loaded(label):
            continue
        if not plist(label).exists():
            log(f"  · {label}: нет plist — не установлена, пропускаю")
            continue
        r = run("launchctl", "bootstrap", domain(), str(plist(label)))
        log(f"  {'✓' if r.returncode == 0 else '✗'} {label} загружена" + ("" if r.returncode == 0 else f": {r.stderr.strip()}"))


def agents_off(log):
    for label in reversed(config()[0]):
        if loaded(label):
            r = run("launchctl", "bootout", f"{domain()}/{label}")
            log(f"  {'✓' if r.returncode == 0 else '✗'} {label} снята" + ("" if r.returncode == 0 else f": {r.stderr.strip()}"))


def app_running(bundle):
    r = run("osascript", "-e", f'application id "{bundle}" is running', timeout=15)
    return r.stdout.strip() == "true"


def apps_on(log):
    for b in config()[1]:
        if not app_running(b):
            r = run("open", "-g", "-b", b)
            log(f"  {'✓' if r.returncode == 0 else '✗'} {b} запущено")


def apps_off(log):
    for b in config()[2]:
        if app_running(b):
            r = run("osascript", "-e", f'tell application id "{b}" to quit', timeout=60)
            log(f"  {'✓' if r.returncode == 0 else '✗'} {b} закрыто")


def python():
    return sys.executable if os.path.isabs(sys.executable) else "/usr/bin/python3"


def desktop_text(down):
    up = T.layer_tools() / "agents_up.py"
    title = "выключаю" if down else "включаю"
    return "\n".join([
        "#!/bin/zsh",
        "# Пишет eval/tools/dev_power.py install — правка руками перезапишется.",
        f"echo 'Разработка: {title}…'",
        f"{shlex.quote(python())} -I {shlex.quote(str(up))}" + (" --down" if down else ""),
        "echo",
        "read -k1 -s '?Готово — любая клавиша закрывает окно.'",
        "",
    ])


def up_plist():
    path = ":".join(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
                     str(home() / ".local" / "bin")])
    return plistlib.dumps({
        "Label": LABEL_UP,
        "ProgramArguments": [python(), "-I", str(T.layer_tools() / "agents_up.py")],
        "EnvironmentVariables": {"PATH": path, "LANG": "en_US.UTF-8"},
        "RunAtLoad": True,  # один раз при входе; сами службы держит launchd
        "StandardOutPath": str(home() / "Library" / "Logs" / "taibe-dev-up.log"),
        "StandardErrorPath": str(home() / "Library" / "Logs" / "taibe-dev-up.log"),
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
    log(f"ярлыки: {desk / DESKTOP_ON}, {desk / DESKTOP_OFF}")
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
