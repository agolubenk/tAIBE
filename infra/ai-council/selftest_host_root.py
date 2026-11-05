#!/usr/bin/env python3
"""AI Council — самопроверка корня хоста (TAIBE_HOST_ROOT). Только stdlib, сети и Ollama нет.

Код консилиума и DAMS живёт в слое, данные — у продукта-хоста. Проверяется, что:
- без env хост = сам слой (поведение репозитория без хоста не меняется);
- неверный env (относительный путь, нет каталога, нет council.db) — громкая ошибка на импорте;
- с env все корни данных (council.db, ключи и .continue/.env, граф, индекс DAMS, ключ GLM)
  смотрят в хост, а код (config.toml, schema.sql, скрипт пайплайна) — в слой;
- замок Ollama один на машину (домашняя папка, вне хостов): два хоста не держат его одновременно,
  убитый kill -9 держатель его не уносит, старая копия слоя в хосте (прежний лок у хоста) тоже исключается;
- рабочая council.db не создаётся молча, только с AI_COUNCIL_INIT_DB=1;
- dams_rag_server с env без индекса хоста отказывается стартовать.

Живая сверка (`--live <корень хоста>`) — только чтение: код слоя с TAIBE_HOST_ROOT и код самого хоста
открывают одну и ту же council.db (тот же inode) и видят одинаковый корпус; DAMS слоя находит маршрут хоста.
Базу открывает sqlite `mode=ro`: Store() не вызывается, миграция схемы не запускается.

Запуск: python3 -E -s infra/ai-council/selftest_host_root.py [--live /путь/к/хосту]
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAYER = HERE.parents[1]
SCRIPTS = LAYER / ".claude" / "scripts"
CLEAN_ENV = ("TAIBE_HOST_ROOT", "AI_COUNCIL_INIT_DB", "AI_COUNCIL_LOCAL_LOCK", "ZAI_API_KEY")

FAILS: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  → {detail}"))
    if not ok:
        FAILS.append(name)


PRELUDE = f"import sys, json; sys.path[:0] = [{str(HERE)!r}, {str(SCRIPTS)!r}]\n"
MACHINE_LOCK_REL = ".local/state/taibe/council/ollama-local.lock"


def child_env(host: str | Path | None, extra: dict[str, str]) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in CLEAN_ENV}
    if host is not None:
        env["TAIBE_HOST_ROOT"] = str(host)
    env.update(extra)
    return env


def py(code: str, host: str | Path | None = None, cwd: Path = HERE, **extra: str) -> subprocess.CompletedProcess:
    """Отдельный процесс: корни считаются на импорте, в этом процессе их не перезагрузить."""
    return subprocess.run([sys.executable, "-E", "-s", "-c", PRELUDE + code], cwd=str(cwd),
                          env=child_env(host, extra), capture_output=True, text=True, timeout=120)


def spawn(code: str, host: str | Path | None = None, **extra: str) -> subprocess.Popen:
    """Как py(), но без ожидания: для процессов, которые должны идти одновременно."""
    return subprocess.Popen([sys.executable, "-E", "-s", "-c", PRELUDE + code], cwd=str(HERE),
                            env=child_env(host, extra), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def last_json(proc: subprocess.CompletedProcess) -> dict:
    lines = [ln for ln in (proc.stdout or "").splitlines() if ln.startswith("{")]
    if proc.returncode != 0 or not lines:
        return {"_error": (proc.stderr or proc.stdout or "")[-600:]}
    return json.loads(lines[-1])


ROOTS = """
import config, store, verifier, cloud, graph_build, retrieval, ollama, dams_common, glm_client
print(json.dumps({
    "config": str(config.REPO_ROOT), "layer": str(config.LAYER_ROOT),
    "config_path": str(config.CONFIG_PATH), "schema": str(store.SCHEMA_PATH),
    "db": str(store.DB_PATH), "verifier": str(verifier.REPO_ROOT), "cloud": str(cloud.REPO_ROOT),
    "dotenv": str(cloud.DOTENV_PATH), "graph": str(graph_build.OUT_DIR), "retrieval": str(retrieval.REPO_ROOT),
    "lock": str(ollama.LOCAL_INFERENCE_LOCK), "legacy_lock": ollama.LEGACY_HOST_LOCK, "dams_db": str(dams_common.DB_PATH), "glm_key": str(glm_client.KEY_PATH),
    "zai": cloud.read_key("zai"),
}))
"""


def default_layer() -> None:
    r = last_json(py(ROOTS))
    check("без TAIBE_HOST_ROOT хост = слой (поведение без хоста не меняется)",
          r.get("config") == str(LAYER) and r.get("layer") == str(LAYER)
          and r.get("db") == str(LAYER / ".claude/council/council.db")
          and r.get("dams_db") == str(LAYER / ".claude/rag/index.db"), r)
    check("без TAIBE_HOST_ROOT замок Ollama — в домашней папке, не в слое",
          r.get("lock") == os.path.join(os.path.expanduser("~"), MACHINE_LOCK_REL), r.get("lock", r))


def bad_env(tmp: Path) -> None:
    empty = tmp / "empty-host"
    empty.mkdir()
    cases = (("относительный путь", "rel/host", "абсолютный путь"),
             ("каталога нет", str(tmp / "missing"), "каталога нет"),
             ("каталог без council.db", str(empty), ".claude/council/council.db"))
    for title, value, needle in cases:
        proc = py("import config", host=value)
        err = proc.stderr or ""
        check(f"неверный TAIBE_HOST_ROOT ({title}) — громкая ошибка на импорте, не пустая база",
              proc.returncode != 0 and "HostRootError" in err and needle in err and "TAIBE_HOST_ROOT" in err,
              (proc.returncode, err[-300:]))
    check("неверный хост не оставил council.db ни в хосте, ни в слое",
          not (empty / ".claude").exists() and not (tmp / "missing").exists(), sorted(p.name for p in tmp.iterdir()))


def host_fixture(tmp: Path) -> Path:
    host = tmp / "host"
    (host / ".claude/council").mkdir(parents=True)
    (host / ".claude/council/council.db").touch()
    (host / ".continue").mkdir()
    (host / ".continue/.env").write_text("ZAI_API_KEY=key-from-host-dotenv\n", encoding="utf-8")
    return host


def host_roots(tmp: Path) -> None:
    host = host_fixture(tmp).resolve()
    home = tmp / "home-roots"
    home.mkdir()
    r = last_json(py(ROOTS, host=host, HOME=str(home)))
    data_ok = (r.get("config") == r.get("verifier") == r.get("cloud") == r.get("retrieval") == str(host)
               and r.get("db") == str(host / ".claude/council/council.db")
               and r.get("dotenv") == str(host / ".continue/.env")
               and r.get("graph") == str(host / "graphify-out")
               and r.get("dams_db") == str(host / ".claude/rag/index.db")
               and r.get("glm_key") == str(host / ".claude/rag/.glm-key"))
    check("с TAIBE_HOST_ROOT все корни данных — у хоста (база, ключи, граф, DAMS, GLM)", data_ok, r)
    check("с TAIBE_HOST_ROOT замок Ollama — машинный (домашняя папка), не у хоста",
          r.get("lock") == str(home / MACHINE_LOCK_REL), r.get("lock", r))
    check("с TAIBE_HOST_ROOT второй, переходный лок — прежний путь у хоста (его держат старые копии слоя)",
          r.get("legacy_lock") == str(host / ".claude/council/ollama-local.lock"), r.get("legacy_lock", r))
    check("ключ провайдера читается из .continue/.env хоста, а не слоя",
          r.get("zai") == "key-from-host-dotenv", r.get("zai", r))
    check("код остаётся в слое: config.toml и schema.sql",
          r.get("config_path") == str(HERE / "config.toml") and r.get("schema") == str(HERE / "schema.sql"), r)
    proc = py("import mcp_server; print(json.dumps({'cwd': str(mcp_server.REPO_ROOT), "
              "'pipeline': str(mcp_server.PIPELINE_SCRIPT)}))", host=host)
    if "No module named 'mcp'" in (proc.stderr or ""):
        print("SKIP  mcp_server: в этом python нет пакета mcp")
    else:
        m = last_json(proc)
        check("mcp_server: cwd дочерних процессов — хост, скрипт пайплайна — слой",
              m.get("cwd") == str(host)
              and m.get("pipeline") == str(LAYER / "infra/scripts/dev-ai/ai-tooling-pipeline.sh"), m)
    proc = py("import sys; sys.path.insert(0, %r); import dams_rag_server" % str(LAYER / "infra/mcp-hub"), host=host)
    if "No module named 'mcp'" in (proc.stderr or ""):
        print("SKIP  dams_rag_server: в этом python нет пакета mcp")
    else:
        check("dams_rag_server: хост без индекса DAMS — отказ на старте",
              proc.returncode != 0 and ".claude/rag/index.db" in (proc.stderr or ""), (proc.stderr or "")[-300:])


SLOT = """
import os, time, ollama
from pathlib import Path
log = Path(os.environ["T_LOG"])
with ollama.local_inference_slot(30):
    with log.open("a") as f: f.write(f"in {time.time()} {ollama.LOCAL_INFERENCE_LOCK}\\n")
    time.sleep(float(os.environ["T_HOLD"]))
    with log.open("a") as f: f.write(f"out {time.time()} {ollama.LOCAL_INFERENCE_LOCK}\\n")
"""

HOLD = """
import os, time, ollama
from pathlib import Path
with ollama.local_inference_slot(10):
    Path(os.environ["T_READY"]).touch()
    time.sleep(120)
"""

OLD_COPY = """
import fcntl, os, time
from pathlib import Path
handle = open(os.environ["T_LOCK"], "a+")
fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
Path(os.environ["T_READY"]).touch()
time.sleep(120)
"""

PROBE = """
import os, time, ollama
started = time.time()
try:
    with ollama.local_inference_slot(float(os.environ["T_WAIT"])):
        got = True
except TimeoutError:
    got = False
print(json.dumps({"got": got, "waited": round(time.time() - started, 2)}))
"""


def machine_lock(tmp: Path) -> None:
    """Замок Ollama один на Mac: консилиумы двух хостов без AI_COUNCIL_LOCAL_LOCK идут по одному."""
    home = tmp / "home"
    home.mkdir()
    hosts = []
    for name in ("host-a", "host-b"):
        (tmp / name / ".claude/council").mkdir(parents=True)
        (tmp / name / ".claude/council/council.db").touch()
        hosts.append((tmp / name).resolve())
    log = tmp / "slot.log"
    procs = [spawn(SLOT, host=h, HOME=str(home), T_LOG=str(log), T_HOLD="0.6") for h in hosts for _ in range(2)]
    errs = [p.communicate(timeout=90)[1][-300:] for p in procs]
    events = [ln.split() for ln in log.read_text().splitlines()] if log.exists() else []
    depth = peak = 0
    for kind, _ts, _lock in sorted(events, key=lambda e: float(e[1])):
        depth += 1 if kind == "in" else -1
        peak = max(peak, depth)
    check("замок Ollama: у двух хостов один файл — в домашней папке, вне хостов",
          {e[2] for e in events} == {str(home / MACHINE_LOCK_REL)}, {e[2] for e in events})
    check("замок Ollama: четыре процесса двух хостов — по одному, без пересечений",
          [p.returncode for p in procs] == [0, 0, 0, 0] and len(events) == 8 and peak == 1,
          (peak, len(events), [p.returncode for p in procs], [e for e in errs if e]))

    ready = tmp / "holder.ready"
    holder = spawn(HOLD, host=hosts[0], HOME=str(home), T_READY=str(ready))
    try:
        deadline = time.time() + 30
        while not ready.exists() and holder.poll() is None and time.time() < deadline:
            time.sleep(0.05)
        busy = last_json(py(PROBE, host=hosts[1], HOME=str(home), T_WAIT="0.5"))
        check("замок Ollama: пока держатель хоста A жив, хост B получает отказ по таймауту",
              ready.exists() and busy.get("got") is False, busy)
    finally:
        os.kill(holder.pid, signal.SIGKILL)
        holder.wait(timeout=10)
    freed = last_json(py(PROBE, host=hosts[1], HOME=str(home), T_WAIT="2"))
    check("замок Ollama: после kill -9 держателя замок свободен сразу",
          holder.returncode == -signal.SIGKILL and freed.get("got") is True and freed.get("waited", 9) < 1.0,
          (holder.returncode, freed))

    ready = tmp / "old-copy.ready"
    old = subprocess.Popen([sys.executable, "-E", "-s", "-c", OLD_COPY], env=child_env(None, {
        "T_LOCK": str(hosts[0] / ".claude/council/ollama-local.lock"), "T_READY": str(ready)}))
    try:
        deadline = time.time() + 30
        while not ready.exists() and old.poll() is None and time.time() < deadline:
            time.sleep(0.05)
        busy = last_json(py(PROBE, host=hosts[0], HOME=str(home), T_WAIT="0.5"))
        other = last_json(py(PROBE, host=hosts[1], HOME=str(home), T_WAIT="0.5"))
        check("замок Ollama: старая копия слоя держит лок у хоста — новый код этого хоста ждёт, другой хост — нет",
              ready.exists() and busy.get("got") is False and other.get("got") is True, (busy, other))
    finally:
        os.kill(old.pid, signal.SIGKILL)
        old.wait(timeout=10)
    held = last_json(py(PROBE, host=hosts[0], HOME=str(home), T_WAIT="2"))
    check("замок Ollama: старая копия завершилась — новый код хоста берёт оба лока", held.get("got") is True, held)


DB_GUARD = """
import os, store
from pathlib import Path
target = Path(os.environ["T_DB"])
store.DB_PATH = target
out = {}
try:
    store.Store(target).close()
    out["created"] = True
except store.CouncilDbMissing as exc:
    out["refused"] = str(exc)
out["exists"] = target.exists()
out["dir_exists"] = target.parent.exists()
other = Path(os.environ["T_OTHER"])
store.Store(other).close()
out["other"] = other.exists()
print(json.dumps(out))
"""


def db_guard(tmp: Path) -> None:
    target, other = tmp / "guard/.claude/council/council.db", tmp / "explicit/test.db"
    r = last_json(py(DB_GUARD, T_DB=str(target), T_OTHER=str(other)))
    check("рабочая council.db без AI_COUNCIL_INIT_DB не создаётся — отказ, каталог не тронут",
          "AI_COUNCIL_INIT_DB=1" in r.get("refused", "") and not r.get("exists") and not r.get("dir_exists"), r)
    check("явный путь (тесты, --db) создаётся как раньше", r.get("other") is True, r)
    r = last_json(py(DB_GUARD, T_DB=str(target), T_OTHER=str(tmp / "explicit/test2.db"), AI_COUNCIL_INIT_DB="1"))
    check("AI_COUNCIL_INIT_DB=1 — новая база создаётся явно", r.get("created") and r.get("exists"), r)
    layer_db = LAYER / ".claude/council/council.db"
    if layer_db.exists():
        print("SKIP  Store() по умолчанию: в слое уже есть council.db")
        return
    proc = py("import store; store.Store()")
    check("Store() в слое без хоста и без базы — отказ, пустая база рядом с кодом не появилась",
          proc.returncode != 0 and "CouncilDbMissing" in (proc.stderr or "") and not layer_db.exists(),
          (proc.stderr or "")[-300:])


LIVE_COUNTS = """
import os, sqlite3, store
db = store.DB_PATH.resolve()
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
n = lambda t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
print(json.dumps({"db": str(db), "ino": os.stat(db).st_ino, "size": os.stat(db).st_size,
                  "corpus": n("corpus_meta"), "vec": n("corpus_vec"), "cards": n("cards")}))
"""


def live(host: Path) -> None:
    host = host.resolve()
    layer = last_json(py(LIVE_COUNTS, host=host))
    host_code = HERE if host == LAYER else host / "infra/ai-council"
    if not (host_code / "store.py").is_file():
        print(f"SKIP  живая сверка с кодом хоста: нет {host_code}/store.py")
        own = {}
    else:
        own = last_json(subprocess.run(
            [sys.executable, "-E", "-s", "-c", f"import sys, json; sys.path.insert(0, {str(host_code)!r})\n"
             + LIVE_COUNTS], cwd=str(host_code), capture_output=True, text=True, timeout=120,
            env={k: v for k, v in os.environ.items() if k not in CLEAN_ENV}))
    print("      слой→хост:", {k: layer.get(k) for k in ("db", "size", "corpus", "vec", "cards")})
    if own:
        print("      код хоста:", {k: own.get(k) for k in ("db", "size", "corpus", "vec", "cards")})
        check("живая сверка: код слоя с TAIBE_HOST_ROOT и код хоста открывают одну council.db, корпус тот же",
              "_error" not in layer and layer.get("ino") == own.get("ino")
              and all(layer.get(k) == own.get(k) for k in ("corpus", "vec", "cards")), (layer, own))
    check("живая сверка: корпус хоста не пуст", (layer.get("corpus") or 0) > 0, layer)
    env = {k: v for k, v in os.environ.items() if k not in CLEAN_ENV}
    env["TAIBE_HOST_ROOT"] = str(host)
    proc = subprocess.run([sys.executable, "-E", "-s", str(SCRIPTS / "rag_query.py"), "web-handoff-ticket",
                           "--type", "api_route"], cwd=str(LAYER), env=env, capture_output=True, text=True,
                          timeout=60)
    check("живая сверка: DAMS слоя с TAIBE_HOST_ROOT находит маршрут хоста",
          proc.returncode == 0 and "auth.controller.ts" in proc.stdout, (proc.stdout + proc.stderr)[-300:])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", help="корень живого хоста (только чтение)")
    args = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="host-root-") as raw:
        tmp = Path(raw).resolve()
        default_layer()
        (tmp / "bad").mkdir()
        bad_env(tmp / "bad")
        host_roots(tmp)
        machine_lock(tmp)
        db_guard(tmp)
    if args.live:
        live(Path(args.live))
    print(f"\n{'OK' if not FAILS else 'FAILED'}: {len(FAILS)} провалов")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
