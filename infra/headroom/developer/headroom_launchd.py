#!/usr/bin/env python3
"""headroom под launchd (OPS-82): прокси API всех сессий на 127.0.0.1:8787 — сервис, а не процесс в окне Terminal.

Через ANTHROPIC_BASE_URL на этот прокси идёт каждая сессия Claude Code: закрыли окно, где он был запущен руками, —
API нет у всех. 16.11 после пересоздания VM Docker контейнер headroom-default пропал, прокси подняли из Terminal и
без флагов канона (`--no-cache`, `--no-http2`). Здесь — LaunchAgent space.hrhelper.headroom, нативный headroom из uv
(та же версия, что образ), флаги и окружение — из манифеста канона ~/.headroom/deploy/default/manifest.json
(`proxy_args`, `base_env`; его пишет `npm run ai-pipeline:headroom-apply`), без флагов, нужных только Docker.

  python3 -I infra/headroom/developer/headroom_launchd.py status      сервис, pid, /readyz, флаги
  python3 -I infra/headroom/developer/headroom_launchd.py plist       plist, который будет записан (ничего не меняет)
  python3 -I infra/headroom/developer/headroom_launchd.py install     записать plist и переключить прокси на сервис
  python3 -I infra/headroom/developer/headroom_launchd.py uninstall --yes   снять сервис (API пропадёт до нового старта)

install: порт 8787 держит headroom вне сервиса — TERM ему (KILL через 10 с), затем сервис; держит другой процесс
(Docker, чужой) — отказ без изменений. Сервис не ответил на /readyz за READY_WAIT с — снять сервис и поднять headroom
отдельным процессом с теми же флагами: API у сессий не пропадает. Пауза API при переключении — секунды старта прокси.
Тесты: test_headroom_launchd.py (launchctl, порт и процессы подменены).
"""
import json
import os
import plistlib
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

LABEL = "space.hrhelper.headroom"
PORT = 8787
READY_WAIT = 60.0
DOCKER_ONLY = {"--headroom-deployment-profile", "--headroom-deployment-runtime"}  # флаг и его значение
CONTAINER_HOME = "/tmp/headroom-home/"  # в контейнере домашние каталоги хоста смонтированы сюда


def home():
    return Path(os.environ.get("HEADROOM_SERVICE_HOME") or Path.home())


def manifest_path():
    return home() / ".headroom" / "deploy" / "default" / "manifest.json"


def plist_path():
    return home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def headroom_bin():
    b = home() / ".local" / "bin" / "headroom"
    return str(b) if b.exists() else (shutil.which("headroom") or str(b))


def canon():
    """(аргументы прокси, окружение) из манифеста: без флагов Docker, пути контейнера — пути хоста."""
    d = json.loads(manifest_path().read_text(encoding="utf-8"))
    raw, args, skip = list(d.get("proxy_args") or []), [], False
    for a in raw:
        if skip:
            skip = False
            continue
        if a in DOCKER_ONLY:
            skip = True
            continue
        args.append(a)
    if "--port" not in args or "--host" not in args:
        raise ValueError("в proxy_args манифеста нет --host и --port")
    env = {}
    for k, v in (d.get("base_env") or {}).items():
        v = str(v)
        env[k] = str(home()) + "/" + v[len(CONTAINER_HOME):] if v.startswith(CONTAINER_HOME) else v
    return args, env


def plist_bytes():
    args, env = canon()
    path = ":".join([str(Path(headroom_bin()).parent), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])
    return plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [headroom_bin(), "proxy", *args],
        "EnvironmentVariables": {**env, "PATH": path},
        "WorkingDirectory": str(home() / ".headroom"),
        # Прокси — путь API каждой сессии: поднимать всегда; сбой старта — не чаще раза в 10 с.
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
        # Журнал запросов headroom пишет сам (~/.headroom/logs/proxy-8787.log); stdout uvicorn — строка на запрос.
        "StandardOutPath": "/dev/null",
        "StandardErrorPath": str(home() / "Library" / "Logs" / "taibe-headroom.log"),
    })


def launchctl(*a):
    return subprocess.run(["launchctl", *a], capture_output=True, text=True, timeout=30)


def domain():
    return f"gui/{os.getuid()}"


def service_pid():
    r = launchctl("print", f"{domain()}/{LABEL}")
    if r.returncode:
        return None
    for ln in r.stdout.splitlines():
        ln = ln.strip()
        if ln.startswith("pid = "):
            return int(ln.split("=", 1)[1])
    return 0  # загружен, но не работает


def listener():
    """(pid, команда) процесса, который слушает 127.0.0.1:8787; (None, '') — порт свободен."""
    r = subprocess.run(["lsof", "-nP", f"-iTCP:{PORT}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True)
    pids = [int(x) for x in r.stdout.split() if x.isdigit()]
    if not pids:
        return None, ""
    c = subprocess.run(["ps", "-ww", "-o", "command=", "-p", str(pids[0])], capture_output=True, text=True)
    return pids[0], c.stdout.strip()


def is_headroom(cmd):
    return "headroom" in cmd and " proxy" in cmd


def ready(timeout=2.0):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/readyz", timeout=timeout) as r:
            return r.status == 200
    except (OSError, ValueError):
        return False


def port_free():
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", PORT)) != 0


def stop(pid, log):
    os.kill(pid, signal.SIGTERM)
    for _ in range(100):
        if port_free():
            return True
        time.sleep(0.1)
    log(f"headroom {pid} не вышел за 10 с — KILL")
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    time.sleep(0.5)
    return port_free()


def wait_ready(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if ready():
            return True
        time.sleep(0.5)
    return False


def fallback(log):
    """Сервис не поднялся: headroom отдельным процессом с теми же флагами — API у сессий не должен пропасть."""
    launchctl("bootout", f"{domain()}/{LABEL}")
    args, env = canon()
    err = open(home() / "Library" / "Logs" / "taibe-headroom.log", "a")
    subprocess.Popen([headroom_bin(), "proxy", *args], env={**os.environ, **env}, cwd=str(home() / ".headroom"),
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err, start_new_session=True)
    ok = wait_ready(READY_WAIT)
    log("запасной процесс headroom " + ("поднят — API есть" if ok else "тоже не ответил — смотри taibe-headroom.log"))
    return ok


def write_plist():
    p = plist_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    data = plist_bytes()
    if p.exists() and p.read_bytes() == data:
        return False
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_bytes(data)
    os.chmod(tmp, 0o600)
    os.replace(tmp, p)
    return True


def install(log=print):
    changed = write_plist()
    spid = service_pid()
    pid, cmd = listener()
    if spid and pid == spid:
        if changed:  # флаги в манифесте сменились — перезапуск сервиса
            launchctl("kickstart", "-k", f"{domain()}/{LABEL}")
            log("флаги сменились — сервис перезапущен")
            return 0 if wait_ready(READY_WAIT) or fallback(log) else 1
        log(f"уже под launchd: pid {spid}")
        return 0
    if pid and not is_headroom(cmd):
        log(f"порт {PORT} держит не headroom ({pid}: {cmd[:80]}) — ничего не меняю. Docker: npm run ai-pipeline:stop")
        return 1
    if spid is not None:
        launchctl("bootout", f"{domain()}/{LABEL}")  # загружен, но порт не его — перезагрузить чисто
    if pid:
        log(f"снимаю headroom вне сервиса: pid {pid}")
        if not stop(pid, log):
            log(f"порт {PORT} не освободился — сервис не ставлю")
            return 1
    r = launchctl("bootstrap", domain(), str(plist_path()))
    if r.returncode and service_pid() is None:
        log(f"launchctl bootstrap: {r.stderr.strip() or r.returncode}")
        return 0 if fallback(log) else 1
    if wait_ready(READY_WAIT):
        log(f"headroom под launchd: pid {service_pid()}, /readyz 200")
        return 0
    log(f"сервис не ответил на /readyz за {READY_WAIT:.0f} с")
    fallback(log)
    return 1


def status():
    spid = service_pid()
    pid, cmd = listener()
    args, env = canon()
    print(f"сервис {LABEL}: " + ("не загружен" if spid is None else f"pid {spid}" if spid else "загружен, не работает"))
    print(f"порт {PORT}: " + (f"pid {pid}" + (" (сервис)" if pid and pid == spid else " (вне сервиса)") if pid
                              else "свободен") + f" · /readyz {'200' if ready() else 'нет ответа'}")
    print(f"флаги канона: {' '.join(args)}")
    if pid and pid != spid:
        missing = [a for a in args if a.startswith("--") and a not in cmd]
        if missing:
            print(f"у процесса на порту нет флагов канона: {' '.join(missing)}")
    return 0 if pid and pid == spid else 1


def main(argv):
    if len(argv) < 2 or argv[1] not in ("status", "plist", "install", "uninstall"):
        print((__doc__ or "").split("\n\n")[1], file=sys.stderr)
        return 2
    if argv[1] == "plist":
        sys.stdout.write(plist_bytes().decode())
        return 0
    if argv[1] == "install":
        return install()
    if argv[1] == "uninstall":
        if "--yes" not in argv:
            print("uninstall снимет прокси API всех сессий — повторите с --yes", file=sys.stderr)
            return 2
        launchctl("bootout", f"{domain()}/{LABEL}")
        plist_path().unlink(missing_ok=True)
        print("сервис снят; поднять: install или npm run ai-pipeline:start (Docker)")
        return 0
    return status()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
