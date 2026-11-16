#!/usr/bin/env python3
"""headroom под launchd (OPS-82): прокси API всех сессий на 127.0.0.1:8787 — сервис, а не процесс в окне Terminal.

Через ANTHROPIC_BASE_URL на этот прокси идёт каждая сессия Claude Code: закрыли окно, где он был запущен руками, —
API нет у всех. 16.11 после пересоздания VM Docker контейнер headroom-default пропал, прокси подняли из Terminal и
без флагов канона (`--no-cache`, `--no-http2`). Здесь — LaunchAgent space.hrhelper.headroom, нативный headroom из uv
(та же версия, что образ), флаги и окружение — из манифеста канона ~/.headroom/deploy/default/manifest.json
(`proxy_args`, `base_env`) без флагов Docker. Манифест проверяется: адрес только 127.0.0.1:8787, флаги и переменные —
по списку (DYLD_*, PYTHON* и чужой адрес не попадут в сервис, который launchd запускает при каждом входе).

  python3 -I infra/headroom/developer/headroom_launchd.py status      сервис, порт, /readyz, расхождение флагов
  python3 -I infra/headroom/developer/headroom_launchd.py plist       plist, который будет записан (ничего не меняет)
  python3 -I infra/headroom/developer/headroom_launchd.py install     записать plist и переключить прокси на сервис
  python3 -I infra/headroom/developer/headroom_launchd.py uninstall --yes   снять сервис (API пропадёт до нового старта)

install: сначала проверяет манифест и бинарь (до любого изменения). Порт держит headroom вне сервиса — TERM ему (KILL
через 10 с), затем сервис; держит чужой процесс — отказ (загруженный сервис при этом снимается: иначе он бьётся о
занятый порт раз в 30 с). Флаги сменились — сервис загружается заново (kickstart взял бы старый plist из памяти
launchd). Сервис не ответил на /readyz за READY_WAIT с — запасной процесс с теми же флагами, код 3: API есть, но не
под launchd. Журнал запросов — ~/.headroom/logs/proxy-8787.log (headroom ротирует его сам); stdout и stderr сервиса
не пишутся (те же строки без ротации), причина сбоя — `status` (код выхода из launchd) и журнал запасного процесса.
Тесты: test_headroom_launchd.py (launchctl, порт и процессы подменены).
"""
import json
import os
import plistlib
import re
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

LABEL = "space.hrhelper.headroom"
HOST, PORT = "127.0.0.1", 8787
READY_WAIT = 60.0
DOCKER_ONLY = {"--headroom-deployment-profile", "--headroom-deployment-runtime"}  # флаг и его значение
CONTAINER_HOME = "/tmp/headroom-home/"  # в контейнере домашние каталоги хоста смонтированы сюда
VALUED = {"--host": re.compile(re.escape(HOST)), "--port": re.compile(str(PORT)), "--mode": re.compile("cache|token"),
          "--backend": re.compile("[a-z][a-z0-9_-]*"), "--openai-api-url": re.compile(r"https://[^\s]+"),
          "--anthropic-api-url": re.compile(r"https://[^\s]+")}
FLAGS = {"--no-telemetry", "--no-http2", "--http2", "--no-cache", "--no-rate-limit", "--no-ccr", "--no-optimize",
         "--no-learn", "--no-subscription-tracking", "--no-read-lifecycle", "--no-memory-tools", "--no-memory-context",
         "--code-aware", "--no-code-aware", "--no-ccr-proactive-expansion"}
ENV_KEY = re.compile(r"(HEADROOM|OLLAMA)_[A-Z0-9_]+|OPENAI_TARGET_API_URL|ANTHROPIC_TARGET_API_URL|TIKTOKEN_CACHE_DIR")
HEADROOM_CMD = re.compile(r"(^|/)headroom proxy( |$)|-m headroom\.cli proxy( |$)")


class Refused(Exception):
    pass


def home():
    return Path(os.environ.get("HEADROOM_SERVICE_HOME") or Path.home())


def manifest_path():
    return home() / ".headroom" / "deploy" / "default" / "manifest.json"


def plist_path():
    return home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def fallback_log():
    return home() / "Library" / "Logs" / "taibe-headroom-fallback.log"


def headroom_bin():
    """~/.local/bin/headroom → инструмент uv headroom-ai; файл и папка не пишутся группой и другими. Без поиска по PATH
    сессии: plist запускает этот путь при каждом входе."""
    link = home() / ".local" / "bin" / "headroom"
    real = Path(os.path.realpath(link))
    tools = Path(os.path.realpath(home() / ".local" / "share" / "uv" / "tools" / "headroom-ai"))
    if tools not in real.parents or not os.access(real, os.X_OK):
        raise Refused(f"нет бинаря headroom из uv ({link} → {real}): uv tool install headroom-ai")
    for p in (real, real.parent):
        if p.stat().st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise Refused(f"{p} пишут группа или другие — не запускаю его из launchd")
    return str(link)


def canon():
    """(аргументы прокси, окружение) из манифеста: без флагов Docker, пути контейнера — пути хоста, всё по спискам."""
    try:
        d = json.loads(manifest_path().read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise Refused(f"манифест {manifest_path()} не читается: {exc}") from exc
    raw, args, seen, i = list(d.get("proxy_args") or []), [], set(), 0
    while i < len(raw):
        a = str(raw[i])
        if a in DOCKER_ONLY:
            i += 2
            continue
        if a in seen:
            raise Refused(f"флаг {a} в манифесте дважды")
        seen.add(a)
        if a in VALUED:
            v = str(raw[i + 1]) if i + 1 < len(raw) else ""
            if not VALUED[a].fullmatch(v):
                raise Refused(f"{a} {v!r} — не по списку (адрес только {HOST}:{PORT})")
            args += [a, v]
            i += 2
        elif a in FLAGS:
            args.append(a)
            i += 1
        else:
            raise Refused(f"флаг {a} не в списке headroom_launchd.py (VALUED/FLAGS) — добавь, если он нужен")
    if not {"--host", "--port"} <= seen:
        raise Refused("в proxy_args манифеста нет --host и --port")
    env = {}
    for k, v in (d.get("base_env") or {}).items():
        v = str(v)
        if not ENV_KEY.fullmatch(k):
            raise Refused(f"переменная {k} не в списке (HEADROOM_*, OLLAMA_*, *_TARGET_API_URL, TIKTOKEN_CACHE_DIR)")
        env[k] = str(home()) + "/" + v[len(CONTAINER_HOME):] if v.startswith(CONTAINER_HOME) else v
    if env.get("HEADROOM_HOST", HOST) != HOST or env.get("HEADROOM_PORT", str(PORT)) != str(PORT):
        raise Refused(f"HEADROOM_HOST/HEADROOM_PORT не {HOST}:{PORT}")
    return args, env


def base_env():
    path = ":".join([str(Path(os.path.realpath(headroom_bin())).parent), "/usr/bin", "/bin"])
    return {"PATH": path, "HOME": str(home()), "LANG": "en_US.UTF-8"}


def plist_bytes():
    args, env = canon()
    return plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [headroom_bin(), "proxy", *args],
        "EnvironmentVariables": {**env, **base_env()},
        "WorkingDirectory": str(home() / ".headroom"),
        # Прокси — путь API каждой сессии: поднимать всегда; порт занят чужим — не чаще раза в 30 с.
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 30,
        "StandardOutPath": "/dev/null", "StandardErrorPath": "/dev/null",
    })


def launchctl(*a):
    return subprocess.run(["launchctl", *a], capture_output=True, text=True, timeout=30)


def domain():
    return f"gui/{os.getuid()}"


def service_info():
    """(pid или 0 — загружен, не работает; None — не загружен; последний код выхода)."""
    r = launchctl("print", f"{domain()}/{LABEL}")
    if r.returncode:
        return None, ""
    pid, last = 0, ""
    for ln in r.stdout.splitlines():
        ln = ln.strip()
        if ln.startswith("pid = "):
            pid = int(ln.split("=", 1)[1])
        elif ln.startswith("last exit code = "):
            last = ln.split("=", 1)[1].strip()
    return pid, last


def service_pid():
    return service_info()[0]


def command(pid):
    c = subprocess.run(["ps", "-ww", "-o", "command=", "-p", str(pid)], capture_output=True, text=True)
    return c.stdout.strip()


def listener():
    """(pid, команда) того, кто слушает :8787; (None, '') — свободно. Два разных процесса — отказ."""
    r = subprocess.run(["lsof", "-nP", f"-iTCP:{PORT}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True)
    pids = sorted({int(x) for x in r.stdout.split() if x.isdigit()})
    if len(pids) > 1:
        raise Refused(f"порт {PORT} слушают несколько процессов: {pids}")
    return (pids[0], command(pids[0])) if pids else (None, "")


def is_headroom(cmd):
    return bool(HEADROOM_CMD.search(cmd))


def ready(timeout=2.0):
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/readyz", timeout=timeout) as r:
            return r.status == 200
    except (OSError, ValueError):
        return False


def port_free():
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((HOST, PORT)) != 0


def wait(cond, seconds, step=0.2):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(step)
    return False


def stop(pid, cmd, log):
    """TERM процессу pid, только пока у него та же команда (pid мог достаться другому), затем KILL через 10 с."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if command(pid) != cmd:
            return wait(port_free, 2)
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return wait(port_free, 2)
        except PermissionError:
            log(f"pid {pid} чужой — не снимаю")
            return False
        if wait(port_free, 10, 0.1):
            return True
        log(f"headroom {pid} не вышел за 10 с — KILL")
    return False


def bootout(log):
    launchctl("bootout", f"{domain()}/{LABEL}")
    if not wait(lambda: service_pid() is None, 10):
        log("launchctl bootout: сервис ещё загружен")
        return False
    return wait(port_free, 15)


def fallback(log):
    """Сервис не поднялся: headroom отдельным процессом с теми же флагами и окружением сервиса (не сессии)."""
    bootout(log)
    args, env = canon()
    fd = os.open(fallback_log(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as err:
        p = subprocess.Popen([headroom_bin(), "proxy", *args], env={**env, **base_env()},
                             cwd=str(home() / ".headroom"), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=err, start_new_session=True)
    ok = wait(ready, READY_WAIT, 0.5) and listener()[0] == p.pid
    log(f"запасной процесс headroom {p.pid} " + ("поднят — API есть, но не под launchd" if ok
                                                 else f"не ответил — {fallback_log()}"))
    return ok


def start_service(log):
    r = launchctl("bootstrap", domain(), str(plist_path()))
    if r.returncode and service_pid() is None:
        log(f"launchctl bootstrap: {r.stderr.strip() or r.returncode}")
    elif wait(ready, READY_WAIT, 0.5):
        log(f"headroom под launchd: pid {service_pid()}, /readyz 200")
        return 0
    else:
        log(f"сервис не ответил на /readyz за {READY_WAIT:.0f} с (код выхода — status)")
    return 3 if fallback(log) else 1


def write_plist():
    data, p = plist_bytes(), plist_path()
    if p.exists() and p.read_bytes() == data:
        return False
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, p)
    return True


def install(log=print):
    try:
        plist_bytes()  # манифест и бинарь — до любого изменения
        pid, cmd = listener()
    except Refused as exc:
        log(f"отказ: {exc}")
        return 1
    spid = service_pid()
    if pid and not is_headroom(cmd):
        if spid is not None:
            bootout(log)
            log("сервис снят: порт занят не им, он бился бы о порт раз в 30 с")
        log(f"порт {PORT} держит не headroom ({pid}: {cmd[:80]}) — не трогаю. Docker: npm run ai-pipeline:stop")
        return 1
    changed = write_plist()
    if spid and pid == spid:
        if not changed:
            log(f"уже под launchd: pid {spid}")
            return 0
        log("флаги сменились — загружаю сервис заново")
        return start_service(log) if bootout(log) else 1
    if spid is not None and not bootout(log):  # загружен, но порт не его — загрузить чисто
        return 1
    if pid:
        log(f"снимаю headroom вне сервиса: pid {pid}")
        if not stop(pid, cmd, log):
            log(f"порт {PORT} не освободился — сервис не ставлю")
            return 1
    return start_service(log)


def drift(cmd, args):
    """Флаги работающего процесса против канона: [] — совпадают."""
    words = cmd.split()
    run = words[words.index("proxy") + 1:] if "proxy" in words else words
    return [a for a in args if a not in run] + [f"лишний {a}" for a in run if a.startswith("--") and a not in args]


def status():
    spid, last = service_info()
    try:
        pid, cmd = listener()
    except Refused as exc:
        pid, cmd = None, ""
        print(f"порт {PORT}: {exc}")
    print(f"сервис {LABEL}: " + ("не загружен" if spid is None else f"pid {spid}" if spid
                                  else f"загружен, не работает (последний код выхода {last or '—'})"))
    print(f"порт {PORT}: " + (f"pid {pid}" + (" (сервис)" if pid == spid else " (вне сервиса)") if pid else "свободен")
          + f" · /readyz {'200' if ready() else 'нет ответа'}")
    try:
        args, _ = canon()
    except Refused as exc:
        print(f"манифест: {exc}")
        return 1
    off = drift(cmd, args) if pid else []
    print("флаги: " + (f"расходятся с каноном: {' '.join(off)} — install" if off else "как в каноне"))
    return 0 if pid and pid == spid and not off else 1


def main(argv):
    if len(argv) < 2 or argv[1] not in ("status", "plist", "install", "uninstall"):
        print((__doc__ or "").split("\n\n")[1], file=sys.stderr)
        return 2
    if argv[1] == "install":
        return install()
    if argv[1] == "uninstall":
        if "--yes" not in argv:
            print("uninstall снимет прокси API всех сессий — повторите с --yes", file=sys.stderr)
            return 2
        if not bootout(print) and service_pid() is not None:
            print("сервис не снялся — plist оставлен")
            return 1
        plist_path().unlink(missing_ok=True)
        print("сервис снят; поднять: install или npm run ai-pipeline:start (Docker)")
        return 0
    try:
        if argv[1] == "plist":
            sys.stdout.write(plist_bytes().decode())
            return 0
    except Refused as exc:
        print(f"отказ: {exc}", file=sys.stderr)
        return 1
    return status()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
