#!/usr/bin/env python3
"""AI Council — самопроверка критичных инвариантов. Только stdlib.

    python3 infra/ai-council/selftest.py

Проверяется то, что ломается молча и обнаруживается только по кривому результату:

* атомарность захвата очереди (два воркера не берут один прогон) — настоящими процессами,
  а не мокам: гонка на SQLite воспроизводится только реальной конкуренцией;
* модельный лок (инвариант «не более одной L-модели резидентно», C1);
* возврат зависших прогонов в очередь;
* идемпотентность создания страниц (у консилиума нет удаления — дубль неисправим);
* валидатор конфига действительно запрещает то, что запрещено правилами борда.

Работает на временной БД, боевую `.claude/council/council.db` не трогает.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from datetime import date as date_cls   # noqa: E402

import config as config_mod          # noqa: E402
from store import Store, sha16, now  # noqa: E402

PASS, FAIL = "\033[32m✓\033[0m", "\033[31m✗\033[0m"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"  {PASS if ok else FAIL} {name}" + (f" — {detail}" if detail else ""))


# ── 1. атомарность захвата очереди ──────────────────────────────────────────
CLAIMER = r"""
import sys, json
sys.path.insert(0, %r)
from store import Store
db, worker = sys.argv[1], sys.argv[2]
s = Store(db)
got = []
while True:
    run = s.claim_run(worker)
    if run is None:
        break
    got.append(run["id"])
s.close()
print(json.dumps(got))
"""


def test_claim_atomicity(tmp: Path) -> None:
    db = tmp / "claim.db"
    total = 60
    with Store(db) as store:
        for i in range(total):
            store.enqueue(f"card{i}", dedupe=False)

    script = tmp / "claimer.py"
    script.write_text(CLAIMER % str(HERE))
    procs = [
        subprocess.Popen([sys.executable, str(script), str(db), f"w{i}"],
                         stdout=subprocess.PIPE, text=True)
        for i in range(6)
    ]
    claimed: list[str] = []
    for p in procs:
        out, _ = p.communicate(timeout=90)
        claimed += json.loads(out.strip().splitlines()[-1])

    check("захват очереди: каждый прогон выдан ровно один раз",
          len(claimed) == len(set(claimed)) == total,
          f"выдано {len(claimed)}, уникальных {len(set(claimed))}, ожидалось {total}")

    with Store(db) as store:
        stuck = store.q1("SELECT COUNT(*) n FROM runs WHERE status = 'queued'")["n"]
    check("захват очереди: ничего не осталось невыданным", stuck == 0, f"queued={stuck}")


# ── 2. модельный лок ────────────────────────────────────────────────────────
def test_model_lock(tmp: Path) -> None:
    db = tmp / "lock.db"
    a, b = Store(db), Store(db)
    check("модельный лок: первый держатель берёт",
          a.acquire_model_lock("worker-a", "qwen3-coder:30b-a3b-q4_K_M"))
    check("модельный лок: второй НЕ берёт (инвариант 24 GB)",
          not b.acquire_model_lock("worker-b", "qwen3.6:27b-q4_K_M"))
    check("модельный лок: тот же держатель реентерабелен",
          a.acquire_model_lock("worker-a", "qwen3-coder:30b-a3b-q4_K_M"))
    a.release_model_lock("worker-a")
    check("модельный лок: после release берёт другой",
          b.acquire_model_lock("worker-b", "qwen3.6:27b-q4_K_M"))

    # Упавший воркер не должен заблокировать очередь навсегда.
    b.x("UPDATE locks SET expires_at = ? WHERE name = 'ollama_large'", (int(time.time()) - 1,))
    check("модельный лок: протухший лок не считается занятым", b.current_model_lock() is None)
    check("модельный лок: протухший лок перехватывается",
          a.acquire_model_lock("worker-c", "mistral-small3.2:latest"))
    a.close()
    b.close()


def test_local_inference_slot(tmp: Path) -> None:
    """Локальный инференс строго последовательный и между процессами: облачная полоса воркера и
    сервис контекста не должны звать Ollama одновременно с основным воркером."""
    import subprocess
    import sys as _sys
    lock = tmp / "ollama-local.lock"
    log = tmp / "slot.log"
    code = (
        "import os, sys, time\n"
        f"os.environ['AI_COUNCIL_LOCAL_LOCK'] = {str(lock)!r}\n"
        f"sys.path.insert(0, {str(Path(__file__).parent)!r})\n"
        "import ollama\n"
        "with ollama.local_inference_slot(30):\n"
        f"    with open({str(log)!r}, 'a') as f: f.write(f'in {{time.time()}}\\n')\n"
        "    time.sleep(0.6)\n"
        f"    with open({str(log)!r}, 'a') as f: f.write(f'out {{time.time()}}\\n')\n"
    )
    procs = [subprocess.Popen([_sys.executable, "-c", code]) for _ in range(3)]
    rcs = [p.wait(timeout=60) for p in procs]
    events = [line.split() for line in log.read_text().splitlines()]
    depth, max_depth = 0, 0
    for kind, _ts in sorted(events, key=lambda e: float(e[1])):
        depth += 1 if kind == "in" else -1
        max_depth = max(max_depth, depth)
    check("локальный инференс: три процесса — по одному, без пересечений",
          rcs == [0, 0, 0] and len(events) == 6 and max_depth == 1, f"rc={rcs} depth={max_depth}")

    import ollama as ollama_mod
    saved_lock = ollama_mod.LOCAL_INFERENCE_LOCK
    holder = subprocess.Popen([_sys.executable, "-c", code.replace("time.sleep(0.6)", "time.sleep(3)")])
    time.sleep(1.0)
    os.environ["AI_COUNCIL_LOCAL_LOCK"] = str(lock)
    try:
        ollama_mod.LOCAL_INFERENCE_LOCK = str(lock)
        started = time.time()
        try:
            with ollama_mod.local_inference_slot(0.5):
                timed_out = False
        except TimeoutError:
            timed_out = True
        check("локальный инференс: занятый лок — отказ по таймауту, не вызов в обход",
              timed_out and time.time() - started < 2.0)
    finally:
        holder.wait(timeout=30)
        ollama_mod.LOCAL_INFERENCE_LOCK = saved_lock
        os.environ.pop("AI_COUNCIL_LOCAL_LOCK", None)


def test_local_lock_holder(tmp: Path) -> None:
    """OPS-31: держатель замка, остановленный Ctrl+Z или SIGSTOP, виден в status по pid и состоянию T, а текст
    таймаута ожидающего называет его и команду status."""
    import signal
    import subprocess
    import sys as _sys
    import ollama as ollama_mod
    lock = tmp / "holder.lock"
    check("лок Ollama: свободный замок — «свободен»", ollama_mod.local_lock_holder(str(lock)) is None)
    code = (
        "import os, sys, time\n"
        f"os.environ['AI_COUNCIL_LOCAL_LOCK'] = {str(lock)!r}\n"
        f"sys.path.insert(0, {str(Path(__file__).parent)!r})\n"
        "import ollama\n"
        "with ollama.local_inference_slot(30):\n"
        "    print('in', flush=True)\n"
        "    time.sleep(30)\n"
    )
    holder = subprocess.Popen([_sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
    saved_lock = ollama_mod.LOCAL_INFERENCE_LOCK
    try:
        holder.stdout.readline()
        os.kill(holder.pid, signal.SIGSTOP)
        os.waitpid(holder.pid, os.WUNTRACED)   # на Linux kill возвращается раньше, чем процесс встал
        h = ollama_mod.local_lock_holder(str(lock))
        check("лок Ollama: держатель под SIGSTOP — его pid и состояние T",
              bool(h) and h["pid"] == holder.pid and h["state"].startswith("T") and h["who"] == "council",
              f"{h}")
        check("лок Ollama: описание подсказывает kill -CONT", f"kill -CONT {holder.pid}" in ollama_mod.describe_holder(h))
        ollama_mod.LOCAL_INFERENCE_LOCK = str(lock)
        try:
            with ollama_mod.local_inference_slot(0.3):
                msg = ""
        except TimeoutError as exc:
            msg = str(exc)
        check("лок Ollama: таймаут называет держателя и команду status",
              str(holder.pid) in msg and "supervisor.py status" in msg, msg[:160])
    finally:
        ollama_mod.LOCAL_INFERENCE_LOCK = saved_lock
        os.kill(holder.pid, signal.SIGCONT)
        holder.kill()
        holder.wait(timeout=10)
    check("лок Ollama: держатель завершён — снова «свободен»", ollama_mod.local_lock_holder(str(lock)) is None)

    # Штатный выход стирает отметку: следующий держатель без отметки (старая копия кода) не выглядит прежним.
    done = subprocess.run([_sys.executable, "-c", code.replace("time.sleep(30)", "pass")], capture_output=True,
                          text=True, timeout=30)
    raw = subprocess.Popen([_sys.executable, "-c",
                            f"import fcntl, time\nf = open({str(lock)!r}, 'a+')\nfcntl.flock(f.fileno(), fcntl.LOCK_EX)\n"
                            "print('in', flush=True)\ntime.sleep(30)\n"], stdout=subprocess.PIPE, text=True)
    try:
        raw.stdout.readline()
        h = ollama_mod.local_lock_holder(str(lock))
        check("лок Ollama: после штатного выхода отметка стёрта — держатель без отметки не выдаётся за прежнего",
              done.returncode == 0 and bool(h) and h["pid"] is None
              and "не записал pid" in ollama_mod.describe_holder(h), f"{h}")
    finally:
        raw.kill()
        raw.wait(timeout=10)


def test_machine_model_lock(tmp: Path) -> None:
    """OPS-29: два хоста (у каждого своя council.db) требуют разные L-модели одновременно — L-блоки идут по
    одному на машину: чужая модель посреди блока не выгружается, пик резидентных L-моделей 1."""
    import subprocess
    import sys as _sys
    lock = tmp / "ollama-local.lock"
    log = tmp / "large.log"
    code = (
        "import os, sys, time\n"
        f"os.environ['AI_COUNCIL_LOCAL_LOCK'] = {str(lock)!r}\n"
        f"sys.path.insert(0, {str(Path(__file__).parent)!r})\n"
        "import ollama, store\n"
        "model, db = sys.argv[1], sys.argv[2]\n"
        "c = ollama.OllamaClient(store=store.Store(db), holder='host-' + model, large={model: 17.0},\n"
        "                        memory_guard=False)\n"
        "c.loaded_models = lambda: []\n"
        "c.unload = lambda name: None\n"
        "with c.large_model(model):\n"
        f"    with open({str(log)!r}, 'a') as f: f.write(f'in {{time.time()}}\\n')\n"
        "    time.sleep(0.6)\n"
        f"    with open({str(log)!r}, 'a') as f: f.write(f'out {{time.time()}}\\n')\n"
    )
    procs = [subprocess.Popen([_sys.executable, "-c", code, m, str(tmp / f"host-{i}.db")])
             for i, m in enumerate(["big:27b", "other:30b", "big:27b"])]
    rcs = [p.wait(timeout=60) for p in procs]
    events = [line.split() for line in log.read_text().splitlines()]
    depth, peak = 0, 0
    for kind, _ts in sorted(events, key=lambda e: float(e[1])):
        depth += 1 if kind == "in" else -1
        peak = max(peak, depth)
    check("модельный лок: три «хоста» со своими базами — L-блоки по одному на машину",
          rcs == [0, 0, 0] and len(events) == 6 and peak == 1, f"rc={rcs} peak={peak}")
    check("модельный лок: машинный файл рядом с локом инференса",
          os.path.exists(tmp / "large-model.lock"))

    import ollama as ollama_mod
    c = ollama_mod.OllamaClient(store=None, large={"big:27b": 17.0}, memory_guard=False)
    c.loaded_models = lambda: []
    c.unload = lambda name: None
    started = time.time()
    with c.large_model("big:27b"):
        with c.large_model("big:27b"):
            nested = True
    check("модельный лок: вложенный large_model в том же процессе не ждёт сам себя",
          nested and time.time() - started < 1.0 and ollama_mod._model_lock["depth"] == 0)


def test_cloud_lane(tmp: Path) -> None:
    """Облачная полоса воркера: пульс долгого прогона и отказ брать задачу без режима GLM 5.x."""
    import council_worker as worker_mod
    db = tmp / "lane.db"
    with Store(db) as store:
        run_id = store.enqueue("card-hb", dedupe=False)
        claimed = store.claim_run("council-x-p1")
        store.x("UPDATE runs SET heartbeat_at = 1 WHERE id = ?", (run_id,))
        with worker_mod._heartbeat_while(run_id, db, every=0.2):
            time.sleep(0.9)
        beat = store.q1("SELECT heartbeat_at FROM runs WHERE id = ?", (run_id,))["heartbeat_at"]
        store.reap_stale(600)
        status = store.q1("SELECT status FROM runs WHERE id = ?", (run_id,))["status"]
        check("полоса: пульс обновляется, пока прогон идёт, — супервизор его не возвращает в очередь",
              claimed is not None and beat > 1 and status == "running", f"beat={beat} status={status}")

        # Полоса берёт только облачное: без тумблера — отмеченное режимом; неотмеченное остаётся основному
        # воркеру (локальный инференс строго по одному). Маршруты — plan_routes, захват — Store.claim_run(route).
        plain = store.enqueue("card-plain", dedupe=False)
        lane = worker_mod.plan_routes(False, True, False, True, True)
        took = store.claim_run("council-cloud-x-p2", route=lane.runs)
        check("полоса: без режима GLM 5.x неотмеченный прогон не берёт — он локальный",
              lane.runs == "glm" and took is None)
        store.x("UPDATE runs SET cloud_mode = 'glm5' WHERE id = ?", (plain,))
        took = store.claim_run("council-cloud-x-p2", route=lane.runs)
        check("полоса: прогон с отметкой GLM 5.x берёт и при выключенном тумблере",
              took is not None and took["id"] == plain, str(took))


def test_memory_guard(tmp: Path) -> None:
    """Memory-guard (2026-10-04): L-модель не грузится, если ей некуда встать; прогон
    откладывается, а не воздерживается. Снимок памяти и /api/ps подменены — тест не
    зависит от того, сколько памяти свободно на машине, где он идёт."""
    import ollama as ollama_mod
    import review_store as review_store_mod

    store = Store(tmp / "guard.db")
    client = ollama_mod.OllamaClient(store=store, holder="guard",
                                     large={"big:27b": 17.4, "other:30b": 18.6, "mid:24b": 15.2})
    resident: list[dict] = []
    client.loaded_models = lambda: resident
    unloaded: list[str] = []
    client.unload = lambda m: unloaded.append(m)
    snap = {"avail_gb": 2.0, "swap_free_gb": 0.8, "pressure": 4}
    original = ollama_mod.memory_snapshot
    ollama_mod.memory_snapshot = lambda: dict(snap)
    try:
        ok, why = client.memory_check("big:27b")
        check("guard: critical-давление, выгружать нечего — L-модель не грузится",
              not ok and "нет памяти" in why, why)
        check("guard: S-модель guard не трогает", client.memory_check("small:7b")[0])
        resident[:] = [{"name": "big:27b", "size": int(17.4 * 2 ** 30)}]
        check("guard: уже резидентная модель проходит всегда", client.memory_check("big:27b")[0])
        resident[:] = [{"name": "other:30b", "size": int(18.6 * 2 ** 30)}]
        check("guard: замена L→L проходит, если выгрузка освобождает не меньше (18.6 → 15.2+1.5)",
              client.memory_check("mid:24b")[0])
        check("guard: замена L→L не проходит, если новая с запасом больше выгружаемой (18.6 → 17.4+1.5)",
              not client.memory_check("big:27b")[0])
        resident[:] = [{"name": "small:7b", "size": int(5.1 * 2 ** 30)}]
        blocked = False
        try:
            with client.large_model("big:27b"):
                pass
        except ollama_mod.MemoryUnavailable:
            blocked = True
        check("guard: large_model бросает MemoryUnavailable и не выгружает чужие модели",
              blocked and not unloaded)
        check("guard: лок отпущен после отказа", store.current_model_lock() is None)
        check("guard: MemoryUnavailable ловится как TimeoutError (путь возврата в очередь)",
              issubclass(ollama_mod.MemoryUnavailable, TimeoutError))
        snap.update(avail_gb=20.0, pressure=1)
        check("guard: памяти хватает — грузится", client.memory_check("big:27b")[0])
        client.memory_guard = False
        snap.update(avail_gb=0.0, pressure=4)
        check("guard: выключен в конфиге — не мешает", client.memory_check("big:27b")[0])
    finally:
        ollama_mod.memory_snapshot = original

    rs = review_store_mod.ReviewStore(store)
    card = {"card_id": "g1", "board": "bugs", "title": "t", "review_hash": "h", "comments": "[]"}
    rs.upsert_card(card)
    run_id = rs.enqueue(card, rs.profile(None), "selftest", {})
    run = rs.claim("w")
    rs.log_step(run_id, 1, "independent", "code_reviewer", "m", {}, "p", "r", None, False, "", 1, 0, 0)
    rs.defer(run_id, 600, "нет памяти")
    check("guard: отложенное ревью не берётся до not_before, частичный транскрипт снесён",
          run is not None and rs.claim("w") is None and not rs.steps(run_id)
          and rs.run(run_id)["status"] == "queued")
    store.close()


def test_queue_control(tmp: Path) -> None:
    """Пауза/продолжение с того же места, возврат снятого, осиротевшие running и фикс
    голодания 2026-10-06 (заблокированный по памяти профиль не морозит очередь)."""
    import queue_control as qc
    import review_store as review_store_mod

    store = Store(tmp / "queue.db")
    ids = {}
    for i, (card, profile, prio) in enumerate([("c1", "deep", 2), ("c2", "fast", 2),
                                                ("c3", "deep", 1), ("c4", "fast", 1)]):
        ids[card] = store.enqueue(card, profile=profile, priority=prio, batch_id="b1")
        store.x("UPDATE runs SET created_at = ? WHERE id = ?", (1000 + i, ids[card]))

    first = store.claim_run("w", exclude_profiles=["deep"])
    check("голодание: заблокированный deep пропускается, берётся fast на его месте",
          first is not None and first["id"] == ids["c2"], first and first["card_id"])
    store.x("UPDATE runs SET status='queued', claimed_by=NULL WHERE id = ?", (first["id"],))

    qc.pause(store, actor="selftest")
    check("пауза: флаг стоит, очередь не тронута",
          qc.is_paused(store) is not None and qc._count(store, "queued") == 4)
    qc.resume(store, actor="selftest")
    check("продолжение: флаг снят", qc.is_paused(store) is None)

    res = qc.pause(store, batch_id="b1")
    check("пауза серии: queued → paused", res["paused"] == 4 and qc._count(store, "queued") == 0)
    check("пауза серии: воркер paused не берёт", store.claim_run("w") is None)
    qc.resume(store, batch_id="b1")
    order = []
    while (run := store.claim_run("w")) is not None:
        order.append(run["card_id"])
        store.finish_run(run["id"], "done")
    check("продолжение серии: тот же порядок (priority, created_at)",
          order == ["c1", "c2", "c3", "c4"], order)

    a = store.enqueue("c5", profile="fast", batch_id="b2")
    b = store.enqueue("c6", profile="fast", batch_id="b2")
    store.x("UPDATE runs SET status='cancelled', outcome='снято владельцем' WHERE id IN (?, ?)", (a, b))
    store.enqueue("c6", profile="deep")                       # карточку уже поставили заново
    res = qc.resume(store, batch_id="b2", include_cancelled=True)
    check("возврат снятых: не начатые — на место, дубль по карточке пропущен",
          res["restored"] == 1 and res["skipped_duplicates"] == 1, res)

    rs = review_store_mod.ReviewStore(store)
    card = {"card_id": "r1", "board": "bugs", "title": "t", "review_hash": "h", "comments": "[]"}
    rs.upsert_card(card)
    prof = rs.profile(None)
    rid = rs.enqueue(card, prof, "selftest", {})
    check("ревью: заблокированный профиль ревью пропускается", rs.claim("w", [prof["id"]]) is None)
    check("ревью: без блокировки берётся", (rs.claim("w") or {}).get("id") == rid)

    orphan = store.enqueue("c7", profile="fast")
    alive = store.enqueue("c8", profile="fast")
    store.x("UPDATE runs SET status='running', claimed_by='council-101010-p999999', attempts=1 WHERE id=?", (orphan,))
    store.x("UPDATE runs SET status='running', claimed_by=? WHERE id=?", (f"council-101010-p{os.getpid()}", alive))
    stale = store.enqueue("c9", profile="deep")
    store.x("UPDATE runs SET not_before=?, error='нет памяти под x' WHERE id=?", (now() + 999, stale))
    rec = qc.recover_orphans(store, "council-202020-p1")
    rows = {r["id"]: r for r in store.q("SELECT id, status, attempts, not_before FROM runs WHERE id IN (?,?,?)",
                                         (orphan, alive, stale))}
    check("рестарт: осиротевший running (мёртвый pid) — обратно в очередь без сожжённой попытки",
          rows[orphan]["status"] == "queued" and rows[orphan]["attempts"] == 0)
    check("рестарт: running живого воркера не трогается", rows[alive]["status"] == "running")
    check("рестарт: отложенное старым guard — на прежнее место, без not_before",
          rows[stale]["not_before"] is None and rec["undeferred"] >= 1, rec)
    check("рестарт: осиротевшее ревью тоже возвращено", rec["review_runs"] == 1, rec)

    blocks = qc.MemoryBlocks(store, ttl=60)
    check("блокировка: первый эпизод логируется, продление — нет",
          blocks.block("runs", "deep", "нет памяти") and not blocks.block("runs", "deep", "нет памяти"))
    check("блокировка: видна в статусе для UI/MCP",
          "runs:deep" in qc.status(store)["memory_blocked"] and blocks.active("runs") == ["deep"])
    blocks.clear("runs", "deep")
    check("блокировка: снята — профиль снова в работе", blocks.active("runs") == [])
    store.close()


def test_bindings(tmp: Path) -> None:
    """Правка привязок — на временной копии config.toml и prompts/, боевые не трогаются."""
    import shutil

    import bindings as bnd
    import council as council_mod
    import review_prompts as rp

    cfg_copy = tmp / "config.toml"
    shutil.copy(bnd.CONFIG_PATH, cfg_copy)
    prompts_copy = tmp / "prompts"
    shutil.copytree(bnd.PROMPTS_DIR, prompts_copy)
    orig_cfg, orig_prompts = bnd.CONFIG_PATH, bnd.PROMPTS_DIR
    bnd.CONFIG_PATH, bnd.PROMPTS_DIR = cfg_copy, prompts_copy
    try:
        cfg = config_mod.load(cfg_copy, strict=False)
        before_comments = cfg_copy.read_text(encoding="utf-8").count("#")
        snapshot = cfg_copy.read_text(encoding="utf-8")
        try:                                   # glm4 уже proposer.arch в fast → валидатор против
            bnd.set_role_model(cfg, "fast", "proposer.code", "glm4:latest", {"glm4:latest"})
            rolled = False
        except bnd.BindingError:
            rolled = cfg_copy.read_text(encoding="utf-8") == snapshot
        check("привязки: правка, ломающая валидацию конфига, откатывается", rolled)
        res = bnd.set_role_model(cfg, "fast", "proposer.code", "glm46v:24k", {"glm46v:24k"})
        cfg2 = config_mod.load(cfg_copy, strict=True)
        check("привязки: роль в кавычках правится точечно, конфиг валиден",
              cfg2.roles("fast")["proposer.code"] == "glm46v:24k" and res["before"] == "qwen2.5:7b",
              res)
        check("привязки: комментарии config.toml сохранены",
              cfg_copy.read_text(encoding="utf-8").count("#") == before_comments)
        bnd.set_role_model(cfg2, "deep", "arbiter", "qwen2.5:7b", {"qwen2.5:7b"})
        check("привязки: голый ключ (arbiter) правится",
              config_mod.load(cfg_copy).roles("deep")["arbiter"] == "qwen2.5:7b")

        def fails(fn) -> bool:
            try:
                fn()
            except bnd.BindingError:
                return True
            return False
        check("привязки: неустановленная модель отклонена",
              fails(lambda: bnd.set_role_model(cfg2, "fast", "arbiter", "nope:1b", {"glm4:latest"})))
        check("привязки: новая роль из UI не создаётся",
              fails(lambda: bnd.set_role_model(cfg2, "fast", "ghost", "glm4:latest", {"glm4:latest"})))
        check("привязки: выход за prompts/ отклонён",
              fails(lambda: bnd.prompt_path("../config")) and fails(lambda: bnd.prompt_path("a/b")))
        bnd.write_prompt("critic.strict", "Ты строгий рецензент.", create_only=True)
        bnd.set_prompt_binding(cfg2, "critic", "critic.strict")
        cfg3 = config_mod.load(cfg_copy, strict=True)
        check("привязки: секция [prompts.bindings] создана, слот → промпт",
              bnd.prompt_bindings(cfg3)["critic"] == "critic.strict")
        check("привязки: create_only не перезаписывает",
              fails(lambda: bnd.write_prompt("critic.strict", "x", create_only=True)))

        orig_dir = council_mod.PROMPTS
        council_mod.PROMPTS = prompts_copy
        council_mod._PROMPT_BINDINGS.clear()
        council_mod._PROMPT_BINDINGS.update({"critic": "critic.strict", "arbiter": "../../etc/passwd"})
        try:
            check("промпты: load_prompt идёт по привязке", council_mod.load_prompt("critic") == "Ты строгий рецензент.")
            check("промпты: мусорная привязка не читает путь за prompts/",
                  council_mod.load_prompt("arbiter") == (prompts_copy / "arbiter.md").read_text(encoding="utf-8").strip())
        finally:
            council_mod.PROMPTS = orig_dir
            council_mod._PROMPT_BINDINGS.clear()

        orig_rp = rp._PROMPTS_DIR
        rp._PROMPTS_DIR = prompts_copy
        rp._CACHE.clear()
        try:
            check("ревью-промпты: без файла — встроенный текст", rp.text("review.judge") == rp.DEFAULTS["review.judge"])
            (prompts_copy / "review.judge.md").write_text("Судья X.", encoding="utf-8")
            check("ревью-промпты: файл переопределяет встроенный", rp.text("review.judge") == "Судья X.")
        finally:
            rp._PROMPTS_DIR = orig_rp
            rp._CACHE.clear()
    finally:
        bnd.CONFIG_PATH, bnd.PROMPTS_DIR = orig_cfg, orig_prompts


def test_cloud_escalation(tmp: Path) -> None:
    """Облачная эскалация (§17.4): задачи, ждущие памяти дольше порога, уходят в облако с
    условиями исходного агента; недоступность провайдеров → проверка API → повтор по ответу
    (квота — сброс + 2 мин, перегрузка — 5 мин). Облако и пинги подменены — сети нет."""
    import cloud as cloud_mod
    import cloud_escalation as ce
    import queue_control as qc
    from ollama import Completion
    from review_engine import ReviewEngine

    # классификация
    cases = [
        ("исчерпано окно плана: 100/100 вызовов за последние 10 ч", ce.QUOTA),
        ("исчерпан лимит облачных вызовов на прогон (12/12, профиль escalation)", ce.RUN_CAP),
        ('HTTP 429: {"error":{"code":"1308","message":"Usage limit reached for 5 hour"}} '
         "— исчерпана квота окна плана", ce.QUOTA),
        ("HTTP 503: The model is overloaded. Please try again later.", ce.OVERLOAD),
        ("сеть/zai: timed out", ce.DOWN),
        # ИИ-шлюз продукта (провайдер gateway, решение d-council-openrouter = fallback-free).
        ('HTTP 503: {"error":{"message":"ИИ-шлюз не настроен","type":"server_error","code":"executive_gateway_not_configured"}}', ce.CONFIG),
        ('HTTP 503: {"error":{"code":"executive_gateway_route_not_configured","message":"Нет правила"}}', ce.CONFIG),
        ('HTTP 429: {"error":{"code":"executive_gateway_daily_limit","message":"$0: доступны только бесплатные модели"}}', ce.QUOTA),
        # OpenRouter через шлюз: дневной лимит бесплатных — квота, поминутный — перегрузка (ревью #349).
        ('HTTP 429: {"error":{"message":"Rate limit exceeded: free-models-per-day. Too Many Requests","code":"executive_gateway_upstream_error"}}', ce.QUOTA),
        ('HTTP 429: {"error":{"message":"Rate limit exceeded: free-models-per-min. Too Many Requests","code":"executive_gateway_upstream_error"}}', ce.OVERLOAD),
        ("ответ не распарсился как JSON", ce.MODEL),
        ("нет ключа для gemini (env GEMINI_API_KEY)", ce.NO_KEY),
        ('HTTP 429: {"status": "RESOURCE_EXHAUSTED"} [retry_after=38]', ce.QUOTA),
        ("HTTP 401: invalid api key", ce.NO_KEY),
    ]
    bad = [(t, k, ce.classify(t)) for t, k in cases if ce.classify(t) != k]
    check("эскалация: классификация отказов облака", not bad, bad)

    now_ts = time.time()
    r = ce.provider_reset("HTTP 429 ... [retry_after=38]", now_ts)
    check("эскалация: Retry-After → время сброса", r is not None and abs(r - (now_ts + 38)) < 1)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now_ts + 10 * 3600))
    expected = min(t for t in ce._reset_candidates(stamp) if t > now_ts)
    check("эскалация: «reset at …» без зоны → самое раннее будущее прочтение",
          ce.provider_reset(f"limit will reset at {stamp}", now_ts) == expected)
    past = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(now_ts - 30 * 3600))
    check("эскалация: прошедший «reset at» не используется",
          ce.provider_reset(f"reset at {past}", now_ts) is None)
    hint = cloud_mod._reset_hint({"Retry-After": "120"}, "")
    hint2 = cloud_mod._reset_hint({}, '{"details":[{"retryDelay": "38s"}]}')
    check("эскалация: cloud._reset_hint сохраняет время сброса до обрезки тела",
          hint == "retry_after=120" and hint2 == "retry_after=38", (hint, hint2))

    # окружение: временная БД, облако без сети, ollama-заглушка
    store = Store(tmp / "escalation.db")

    class Cfg:
        def __init__(self, data):
            self.data = data

        def get(self, key, default=None):
            node = self.data
            for part in key.split("."):
                if not isinstance(node, dict) or part not in node:
                    return default
                node = node[part]
            return node

        def config_hash(self):
            return "selftest"

    cfg = Cfg({"models": {"cloud_escalation": {
        "enabled": True, "after_seconds": 7200, "providers": ["zai", "gemini"],
        "models": {"zai": {"proposer.code": "glm-4.6", "arbiter": "glm-5.2", "judge": "glm-5",
                           "default": "glm-4.6"},
                   "gemini": {"default": "gemini-3.6-flash"}}}}})
    budget = cloud_mod.Budget(enabled=True, window_hours=10, max_calls_per_window=5,
                              max_calls_per_day=50, max_calls_per_run_by_profile={"escalation": 3})
    cloud = cloud_mod.CloudClient(
        providers={"zai": {"models": ["glm-4.6", "glm-5", "glm-5.2"], "key": "x", "fallback": {}},
                   "gemini": {"models": ["gemini-3.6-flash"], "key": "x", "fallback": {}}},
        budget=budget, store=store)

    class FakeOllama:
        def is_large(self, model):
            return model in {"big:30b", "big-embed"}

        def memory_check(self, model):
            return (not self.is_large(model), "нет памяти" if self.is_large(model) else "")

        def context_length(self, model):
            return None

    esc = ce.Escalation(cfg, store, FakeOllama(), cloud)
    # Задача «только для GLM 5.x» другому провайдеру не эскалируется — ждёт GLM (вторая очередь, 2026-10-15).
    old_ts = int(time.time()) - esc.after - 60
    marked = store.enqueue("card-esc-glm", profile="deep", dedupe=False, cloud_mode="glm5")
    plain = store.enqueue("card-esc-plain", profile="deep", dedupe=False)
    store.x("UPDATE runs SET mem_wait_since = ? WHERE id IN (?, ?)", (old_ts, marked, plain))
    got = esc.claim("runs", "w-esc", ["deep"])
    nxt = esc.claim("runs", "w-esc", ["deep"])
    check("эскалация: отмеченная GLM 5.x задача не уходит другому провайдеру, обычная — уходит",
          (got or {}).get("id") == plain and nxt is None, (got, nxt))
    store.x("DELETE FROM runs WHERE id IN (?, ?)", (marked, plain))
    roster = {"proposer.code": "big:30b", "proposer.skeptic": "glm4:latest",
              "embed": "big-embed", "arbiter": "glm-5"}
    check("эскалация: в облако — только L-роли (S локально, embed и облачные не трогаются)",
          esc.heavy_slots(roster) == {"proposer.code": "proposer.code"}, esc.heavy_slots(roster))

    provider, mapping, failures = esc.choose("run_a", {"proposer.code": "proposer.code"})
    check("эскалация: выбор провайдера — первый доступный, модель по слоту роли",
          provider == "zai" and mapping == {"proposer.code": "glm-4.6"} and not failures,
          (provider, mapping, failures))
    cloud._down_until["zai"] = time.time() + 300
    provider, mapping, failures = esc.choose("run_a", {"proposer.code": "proposer.code"})
    check("эскалация: провайдер недоступен → следующий (gemini), отказ записан",
          provider == "gemini" and mapping == {"proposer.code": "gemini-3.6-flash"}
          and failures and failures[0].kind == ce.DOWN, (provider, mapping, failures))
    cloud._down_until.clear()

    # окно: 5/5 занято → прогону (потолок 3) нужно дождаться выхода 3-го старейшего вызова
    base = int(time.time())
    for hours_ago in (9, 8, 7, 6, 5):
        store.x("INSERT INTO cloud_usage (run_id, role, provider, model, tokens_in, tokens_out, usd, "
                "ms, ok, refused, error, created_at) VALUES ('x','r','zai','glm-4.6',0,0,0,0,1,'','',?)",
                (base - hours_ago * 3600,))
    gap = esc.budget_gap(esc.need_calls())
    check("эскалация: не начинаем, если окно не вместит потолок прогона; сброс = выход 3-го старейшего",
          gap is not None and gap.kind == ce.QUOTA
          and abs(gap.reset_at - (base - 7 * 3600 + 10 * 3600)) < 2, gap)
    pinged = []
    cloud.ping = lambda model, **kw: (pinged.append(model) or (True, "ok"))
    d = esc.decide([gap])
    check("эскалация: «токенов не хватило» → время сброса + 2 мин, без пинга (API не вызывался)",
          abs(d.retry_at - (gap.reset_at + 120)) < 2 and d.kind == ce.QUOTA and not pinged, d)
    store.x("DELETE FROM cloud_usage")

    # проверка API после отказа всех провайдеров
    def pings(answers):
        def fake(model, **kw):
            pinged.append(model)
            return answers[model]
        return fake
    pinged.clear()
    cloud.ping = pings({"glm-4.6": (False, "HTTP 503: model overloaded, try again later"),
                        "gemini-3.6-flash": (False, 'HTTP 429: {"status":"RESOURCE_EXHAUSTED"} [retry_after=600]')})
    now_ts = time.time()
    d = esc.decide([ce.Failure("zai", "glm-4.6", ce.OVERLOAD, None, "HTTP 503")])
    check("эскалация: перегружен → повтор через 5 мин (раньше, чем сброс квоты другого провайдера)",
          d.kind == ce.OVERLOAD and abs(d.retry_at - (now_ts + 300)) < 3 and len(pinged) == 2, d)
    pinged.clear()
    cloud.ping = pings({"glm-4.6": (False, "HTTP 429: quota [retry_after=1000]"),
                        "gemini-3.6-flash": (False, "HTTP 429: quota exceeded")})
    now_ts = time.time()
    d = esc.decide([ce.Failure("zai", "glm-4.6", ce.QUOTA, None, "HTTP 429")])
    check("эскалация: квота у всех → ближайший известный сброс + 2 мин",
          d.kind == ce.QUOTA and abs(d.retry_at - (now_ts + 1000 + 120)) < 3, d)
    pinged.clear()
    cloud.ping = pings({"glm-4.6": (True, "ответ за 300 мс"), "gemini-3.6-flash": (True, "")})
    now_ts = time.time()
    d = esc.decide([ce.Failure("zai", "glm-4.6", ce.DOWN, None, "сеть/zai")])
    check("эскалация: пинг ответил → сбой разовый, повтор через минуту, дальше не пингуем",
          abs(d.retry_at - (now_ts + 60)) < 3 and pinged == ["glm-4.6"], (d, pinged))

    # вызов с переходом на другой провайдер
    calls = []

    def fake_chat(run_id, role, model, messages, **kw):
        calls.append(model)
        if model.startswith("glm"):
            return Completion(False, "", None, model, 5, 0, 0, "HTTP 503: overloaded")
        return Completion(True, "{}", {"ok": 1}, model, 5, 1, 1)
    cloud.chat = fake_chat
    failed = []
    esc.start("run_b", "zai")
    res = esc.chat("run_b", "proposer.code", "glm-4.6", [{"role": "user", "content": "x"}],
                   slot="proposer.code", on_fail=lambda m, r: failed.append(m))
    check("эскалация: провайдер упал посреди прогона → тот же запрос следующему",
          res.ok and res.model == "gemini-3.6-flash" and failed == ["glm-4.6"] and "zai" in esc.demoted)
    calls.clear()
    esc.chat("run_b", "arbiter", "glm-5.2", [{"role": "user", "content": "x"}], slot="arbiter")
    check("эскалация: отказавший провайдер разжалован до конца прогона", calls == ["gemini-3.6-flash"], calls)
    cloud.chat = lambda *a, **kw: Completion(False, "", None, a[2], 1, 0, 0, "сеть/gemini: down")
    esc.start("run_c", "zai")
    try:
        esc.chat("run_c", "arbiter", "glm-5.2", [], slot="arbiter")
        raised = False
    except ce.CloudUnavailable as exc:
        raised = len(exc.failures) == 2
    check("эскалация: отказали все провайдеры → CloudUnavailable (прогон в очередь, не воздержание)", raised)
    seq = iter([Completion(False, "", None, "glm-5.2", 1, 0, 0, "сеть/zai: The read operation timed out"),
                Completion(True, "{}", {"ok": 1}, "glm-5.2", 1, 1, 1)])
    cloud._down_until["zai"] = time.time() + 300           # так ставит CloudClient после таймаута
    cloud.chat = lambda *a, **kw: next(seq)
    esc.start("run_t", "zai")
    res = esc.chat("run_t", "arbiter", "glm-5.2", [], slot="arbiter")
    check("эскалация: таймаут ответа → повтор тем же провайдером, без перехода и разжалования",
          res.ok and res.model == "glm-5.2" and not esc.demoted and "zai" not in cloud._down_until)
    cloud.chat = lambda *a, **kw: Completion(False, "x", None, a[2], 1, 0, 0, "ответ не распарсился как JSON")
    esc.start("run_d", "zai")
    res = esc.chat("run_d", "arbiter", "glm-5.2", [], slot="arbiter")
    check("эскалация: плохой ответ модели — не повод менять провайдера", not res.ok and not esc.demoted)

    # очередь: стаж ожидания памяти, захват, откладывание
    ids = {}
    for card, profile in (("e1", "deep"), ("e2", "deep"), ("e3", "fast")):
        ids[card] = store.enqueue(card, profile=profile, priority=1)
    blocks = qc.MemoryBlocks(store)
    blocks.block("runs", "deep", "нет памяти")
    marked = store.q1("SELECT COUNT(*) n FROM runs WHERE mem_wait_since IS NOT NULL")["n"]
    check("эскалация: блокировка профиля ставит стаж ожидания его задачам", marked == 2, marked)
    check("эскалация: задачу, ждущую меньше порога, облако не берёт",
          esc.claim("runs", "w", ["deep"]) is None)
    store.x("UPDATE runs SET mem_wait_since = ? WHERE id = ?", (int(time.time()) - 3 * 3600, ids["e1"]))
    store.x("UPDATE runs SET mem_wait_since = ? WHERE id = ?", (int(time.time()) - 3 * 3600, ids["e3"]))
    check("эскалация: профиль, у которого память есть, в облако не уходит",
          esc.claim("runs", "w", ["fast-not-blocked"]) is None)
    got = esc.claim("runs", "w", ["deep"])
    check("эскалация: ждущая дольше порога задача заблокированного профиля захвачена",
          got is not None and got["id"] == ids["e1"] and got["status"] == "running")
    cloud.ping = lambda model, **kw: (False, "HTTP 503: overloaded")
    d = esc.defer("runs", ids["e1"], [ce.Failure("zai", "glm-4.6", ce.OVERLOAD, None, "HTTP 503")])
    row = store.q1("SELECT status, attempts, cloud_retry_at, escalation, started_at FROM runs WHERE id = ?",
                   (ids["e1"],))
    info = json.loads(row["escalation"])
    check("эскалация: отказ облака → задача на месте, попытка не сожжена, повтор назначен",
          row["status"] == "queued" and row["attempts"] == 0 and row["cloud_retry_at"] == d.retry_at
          and info["state"] == "waiting_cloud" and info["deferrals"] == 1, row)
    check("эскалация: возврат в очередь сбрасывает started_at (иначе wall_ms считается от первого захвата)",
          row["started_at"] is None, row["started_at"])
    check("эскалация: облако на паузе для всей эскалации до времени повтора", not esc.ready())
    check("эскалация: до времени повтора задачу не берут снова", esc.claim("runs", "w", ["deep"]) is None)
    gid = store.enqueue("e9", profile="deep", priority=1)
    store.x("UPDATE runs SET mem_wait_since = ? WHERE id = ?", (int(time.time()) - 3 * 3600, gid))
    for _ in range(3):
        cloud._calls_this_run[gid] = 4                      # потрачено в прерванной попытке
        esc.defer("runs", gid, [ce.Failure("zai", "glm-4.6", ce.OVERLOAD, None, "HTTP 503")])
    grow = store.q1("SELECT cloud_retry_at, escalation FROM runs WHERE id = ?", (gid,))
    ginfo = json.loads(grow["escalation"])
    check("эскалация: после 3 откладываний подряд облако для задачи отложено надолго, траты учтены",
          ginfo["state"] == "gave_up" and ginfo["calls_spent"] == 12
          and grow["cloud_retry_at"] >= int(time.time()) + esc.giveup_seconds - 5, ginfo)
    store.x("UPDATE runs SET status='done' WHERE id = ?", (gid,))
    esc.mark_done("runs", ids["e1"], "zai", {"proposer.code": {"from": "big:30b", "to": "glm-4.6"}}, 9000)
    info = json.loads(store.q1("SELECT escalation FROM runs WHERE id = ?", (ids["e1"],))["escalation"])
    check("эскалация: итог записан на прогоне, пауза облака снята",
          info["state"] == "done" and info["provider"] == "zai" and esc.cooldown() is None)
    blocks.clear("runs", "deep")
    left = store.q1("SELECT COUNT(*) n FROM runs WHERE profile='deep' AND status='queued' "
                    "AND mem_wait_since IS NOT NULL")["n"]
    check("эскалация: память вернулась → стаж ожидания снят (идут локально, бесплатно)", left == 0, left)

    # ревью: подмена L-агентов с сохранением условий исходного агента
    cloud.chat = fake_chat
    store.x("DELETE FROM cloud_usage")
    engine = ReviewEngine(cfg, store, FakeOllama(), None, cloud)
    plan = {"judge": "judge", "agents": {
        "code_reviewer": {"label": "Code reviewer", "kind": "reviewer", "focus": "регрессии",
                          "can_block": True, "model": "big:30b", "cloud": False,
                          "options": {"temperature": 0.15, "num_ctx": 13900, "num_predict": 2500},
                          "top_level": {"think": False}, "num_ctx": 13900, "num_predict": 2500,
                          "input_budget": 10000, "notes": []},
        "judge": {"label": "Судья", "kind": "judge", "focus": "", "can_block": False,
                  "model": "deepseek-r1:7b", "cloud": False, "options": {"temperature": 0.1},
                  "top_level": {}, "num_ctx": 8192, "num_predict": 2500, "input_budget": 4000,
                  "notes": []}}}
    info = engine._escalate_plan({"id": "rv_x", "mem_wait_since": int(time.time()) - 8000}, plan, esc)
    a = plan["agents"]["code_reviewer"]
    check("эскалация ревью: L-агент → облачная модель; фокус, вето, temperature и бюджет досье — прежние",
          a["model"] == "glm-4.6" and a["cloud"] and a["options"] == {"temperature": 0.15}
          and a["input_budget"] == 10000 and a["can_block"] and a["focus"] == "регрессии"
          and info["models"]["code_reviewer"]["from"] == "big:30b")
    check("эскалация ревью: S-агент остаётся локальным", plan["agents"]["judge"]["model"] == "deepseek-r1:7b")
    engine.escalation = None

    import council_worker as worker_mod
    store.x("UPDATE review_runs SET status='done' WHERE status IN ('queued', 'running')")
    prof_id = "rp_selftest"
    for i in range(2):
        store.x("INSERT INTO review_runs (id, card_id, board, status, profile_id, mem_wait_since, created_at) "
                "VALUES (?, ?, 'bugs', 'queued', ?, ?, ?)",
                (f"rv_w{i}", f"c{i}", prof_id, int(time.time()) - 3 * 3600, int(time.time())))
    rblocks = qc.MemoryBlocks(store)
    rblocks.block("review", prof_id, "нет памяти")
    original_process = worker_mod.process_review
    worker_mod.process_review = lambda *a, **kw: ("ok", "")
    try:
        worker_mod._run_review(cfg, None, {"id": "rv_w0", "profile_id": prof_id, "profile_name": "x"},
                               rblocks, escalation=object())
    finally:
        worker_mod.process_review = original_process
    left = store.q1("SELECT COUNT(*) n FROM review_runs WHERE profile_id = ? AND mem_wait_since IS NOT NULL",
                    (prof_id,))["n"]
    check("эскалация: облачное ревью не снимает блок памяти и не обнуляет стаж ожидания остальных",
          rblocks.active("review") == [prof_id] and left == 2, (rblocks.active("review"), left))

    import council as council_mod
    check("эскалация: слот роли из метки транскрипта",
          council_mod._role_slot("critic(proposer.code)") == "proposer.code"
          and council_mod._role_slot("arbiter(revise)") == "arbiter"
          and council_mod._role_slot("adversary") == "adversary")
    store.close()


# ── 3. возврат зависших прогонов ────────────────────────────────────────────
def test_reap(tmp: Path) -> None:
    db = tmp / "reap.db"
    with Store(db) as store:
        run_id = store.enqueue("card-stale", dedupe=False)
        store.claim_run("dead-worker")
        store.x("UPDATE runs SET heartbeat_at = ? WHERE id = ?",
                (int(time.time()) - 5000, run_id))

        check("reap: свежий прогон не трогается", store.reap_stale(ttl_seconds=99999) == 0)
        check("reap: зависший возвращён в очередь", store.reap_stale(ttl_seconds=60) == 1)
        check("reap: статус снова queued",
              store.q1("SELECT status FROM runs WHERE id=?", (run_id,))["status"] == "queued")

        for _ in range(3):                      # исчерпать лимит попыток
            store.claim_run("dead-worker")
            store.x("UPDATE runs SET heartbeat_at = ? WHERE id = ?",
                    (int(time.time()) - 5000, run_id))
            store.reap_stale(ttl_seconds=60)
        check("reap: после лимита попыток прогон падает, а не крутится вечно",
              store.q1("SELECT status FROM runs WHERE id=?", (run_id,))["status"] == "failed")


# ── 4. идемпотентность и дедуп ──────────────────────────────────────────────
def test_idempotency(tmp: Path) -> None:
    db = tmp / "idem.db"
    with Store(db) as store:
        first = store.enqueue("card-x", track="elaborate")
        second = store.enqueue("card-x", track="elaborate")
        check("очередь: повторная постановка той же карточки не дублируется",
              first is not None and second is None)
        other = store.enqueue("card-x", track="half_baked")
        check("очередь: другой трек той же карточки ставится", other is not None)

        key = sha16("parent-1" + "Вынести STT в common/stt")
        store.remember_created_page(key, "page-1", "parent-1", "tasks", "Вынести STT", "run-1")
        store.remember_created_page(key, "page-DUP", "parent-1", "tasks", "Вынести STT", "run-2")
        found = store.find_created_page(key)
        check("создание страниц: повторный прогон находит свою карточку, а не плодит дубль",
              found is not None and found["page_id"] == "page-1",
              f"page_id={found['page_id'] if found else None}")


def test_escalate_rules() -> None:
    """d-council-run = narrow (17.10): в deep — только critical и P0, по правилам из config.toml."""
    import council_worker as worker_mod

    class _Cfg:
        def __init__(self, rules: dict) -> None:
            self.rules = rules

        def get(self, key: str, default=None):
            return self.rules if key == "models.escalate_to_deep_when" else default

    class _Out:
        def __init__(self, status: str, confidence: float = 0.9) -> None:
            self.status, self.confidence = status, confidence

    shipped = config_mod.load(strict=False).get("models.escalate_to_deep_when", {})
    cfg = _Cfg(shipped)
    esc = worker_mod.should_escalate
    check("эскалация: critical-ошибка уходит в deep",
          esc(cfg, {"severity": "critical", "modules": "[]"}, _Out("done")))
    check("эскалация: задача P0 без severity уходит в deep",
          esc(cfg, {"priority": "P0", "modules": "[]"}, _Out("done")))
    check("эскалация: high-ошибка остаётся на fast",
          not esc(cfg, {"severity": "high", "modules": "[]"}, _Out("done")))
    check("эскалация: воздержание fast у обычной карточки не будит deep",
          not esc(cfg, {"priority": "P2", "modules": "[]"}, _Out("abstained", 0.1)))
    check("эскалация: half-baked и много модулей не будят deep",
          not esc(cfg, {"half_baked": 1, "modules": '["a","b","c","d","e"]'}, _Out("done", 0.2)))
    wide = _Cfg({"severity_in": ["critical", "high"], "fast_abstained": True})
    check("эскалация: прежние правила по-прежнему работают, если их вернуть",
          esc(wide, {"severity": "high", "modules": "[]"}, _Out("done"))
          and esc(wide, {"priority": "P2", "modules": "[]"}, _Out("abstained")))


# ── 5. валидатор конфига защищает правила борда ─────────────────────────────
def test_config_guards(tmp: Path) -> None:
    base = (HERE / "config.toml").read_text(encoding="utf-8")

    def problems_with(patched: str) -> list[str]:
        path = tmp / f"cfg_{abs(hash(patched)) % 10**8}.toml"
        path.write_text(patched, encoding="utf-8")
        cfg = config_mod.load(path, strict=False)
        return getattr(cfg, "problems", [])

    check("конфиг: боевой валиден", not problems_with(base))

    # ИИ-шлюз продукта (d-council-openrouter = fallback-free): провайдер объявлен, бесплатен, идёт в эскалации
    # только после GLM, ключ — свой источник.
    import cloud as cloud_mod
    live = config_mod.load(HERE / "config.toml", strict=False)
    order = list(live.get("models.cloud_escalation.providers", []) or [])
    check("шлюз: провайдер gateway объявлен с моделями executive.*",
          set(live.get("models.cloud.providers.gateway.models", []) or []) == {"executive.fast", "executive.standard", "executive.deep"})
    check("шлюз: в эскалации — после zai", "gateway" in order and order.index("gateway") > order.index("zai"), str(order))
    pricing = live.get("models.cloud.pricing", {}) or {}
    check("шлюз: модели бесплатны (цена 0)", all(
        (pricing.get(m) or {}).get("in_per_mtok", 1) == 0 and (pricing.get(m) or {}).get("out_per_mtok", 1) == 0
        for m in ("executive.fast", "executive.standard", "executive.deep")))
    check("шлюз: ключ — HRH_GATEWAY_KEY или .claude/council/.gateway-key",
          cloud_mod.KEY_SOURCES.get("gateway") == ("HRH_GATEWAY_KEY", ".claude/council/.gateway-key"))
    no_gateway = base.replace('[models.cloud.providers.gateway]', '[models.cloud.providers.gatewayx]')
    check("шлюз: эскалация на необъявленный провайдер — ошибка конфига",
          any("cloud_escalation" in p for p in problems_with(no_gateway)))
    gw_roles = live.get("models.cloud_escalation.models", {}).get("gateway", {}) or {}
    check("шлюз: арбитр не на модели автора предложения",
          gw_roles.get("arbiter") not in (gw_roles.get("proposer.code"), gw_roles.get("proposer.arch")), str(gw_roles))

    import tomllib
    parsed = tomllib.loads(base)
    check("конфиг: секции Notion нет — источник t-boards, записи наружу нет",
          "notion" not in parsed.get("sources", {}) and "notion_writeback" not in parsed.get("outputs", {})
          and "tboards" in parsed.get("sources", {}))
    bad_notion = base + "\n[outputs.notion_writeback]\ncomments = true\n"
    check("конфиг: возврат [outputs.notion_writeback] — ошибка (R-084, OPS-26)",
          any("outputs.notion_writeback" in p for p in problems_with(bad_notion)))
    bad_budget = base.replace("call_budget = 40", "call_budget = 500")
    check("конфиг: бюджет запросов t-boards выше лимита ключа — ошибка",
          any("call_budget" in p for p in problems_with(bad_budget)))

    bad_mem = base.replace("max_resident_large = 1", "max_resident_large = 2")
    check("конфиг: >1 резидентной L-модели ловится (24 GB, C1)",
          any("max_resident_large" in p for p in problems_with(bad_mem)))

    # L-модель объявлена в самой фикстуре: проверяется правило, а не набор моделей на Mac.
    bad_fast = base.replace(
        '[models.large]\n', '[models.large]\n"heavy-test:30b" = 18.6\n', 1).replace(
        '[models.roles.fast]\n"proposer.code" = "qwen2.5:7b"',
        '[models.roles.fast]\n"proposer.code" = "heavy-test:30b"')
    check("конфиг: тяжёлая модель в профиле fast ловится",
          any("roles.fast" in p for p in problems_with(bad_fast)))

    bad_profile = base.replace('profile = "adaptive"', 'profile = "turbo"')
    check("конфиг: неизвестный профиль ловится",
          any("profile" in p for p in problems_with(bad_profile)))

    # Облачная модель в локальном ростере = платный вызов на КАЖДОЙ из 125 карточек.
    bad_cloud_role = base.replace('"proposer.arch" = "glm4:latest"',
                                  '"proposer.arch" = "glm-5.2"', 1)
    check("конфиг: облачная модель в локальном ростере ловится",
          any("облачная модель" in p for p in problems_with(bad_cloud_role)))

    # Скептик deep = его же proposer.code. Значение берём из конфига: literal glm-4.6 молча
    # перестал быть дублем, когда proposer.code стал локальным тегом (Tiel-Coder, 2026-10-28).
    deep_section = re.search(r"\[models\.roles\.deep\](.*?)(?=\n\[)", base, re.S).group(1)
    deep_code = re.search(r'"proposer\.code"\s*=\s*"([^"]+)"', deep_section).group(1)
    skeptic_line = re.search(r'^"proposer\.skeptic"\s*=\s*"[^"]+"', deep_section, re.M).group(0)
    bad_dup = base.replace(skeptic_line, f'"proposer.skeptic" = "{deep_code}"')
    check("конфиг: одна модель на двух ролях proposer ловится",
          any("независимых мнений" in p for p in problems_with(bad_dup)))

    # Ключ живёт на подписке: General API вернёт 429 «Insufficient balance» на всём.
    bad_endpoint = base.replace("https://api.z.ai/api/coding/paas/v4",
                                "https://api.z.ai/api/paas/v4")
    check("конфиг: General API вместо endpoint подписки ловится",
          any("General API" in p for p in problems_with(bad_endpoint)))

    # Подставляемые строки берутся из самого конфига, а не пишутся здесь буквально:
    # стоило владельцу поменять judge с glm-5 на glm-5.2, как `replace` перестал что-либо
    # заменять — и три проверки «прошли» на неизменённом конфиге, ничего не проверив.
    judge_line = re.search(r'^judge\s*=\s*"[^"]+"', base, re.M).group(0)
    ladder_line = re.search(r'^ladder\s*=\s*\[[^\]]*\]', base, re.M).group(0)

    bad_judge = base.replace(judge_line, 'judge = "glm-9000"')
    check("конфиг: необъявленная облачная модель в roles ловится",
          any("glm-9000" in p for p in problems_with(bad_judge)))

    bad_ladder = base.replace(ladder_line, 'ladder = ["glm-4.6", "glm-нет-такой"]')
    check("конфиг: несуществующая ступень лестницы ловится",
          any("glm-нет-такой" in p for p in problems_with(bad_ladder)))

    # judge вне лестницы = обход начнётся с первой ступени, «дешёвый шаг сначала» ломается.
    off_ladder = base.replace(judge_line, 'judge = "glm-4.6"').replace(
        ladder_line, 'ladder = ["glm-4.7", "glm-5", "glm-5.2"]')
    check("конфиг: стартовая ступень вне лестницы ловится",
          any("отсутствует в ladder" in p for p in problems_with(off_ladder)))

    # Тот же принцип, что judge/ladder выше: значение берётся из конфига, а не пишется
    # буквально. Буквальный "max_calls_per_day = 60" протух в тот же день, когда
    # владелец поднял суточный потолок до 120 — replace молча перестал заменять,
    # валидатору стало нечего ловить, и проверка «шла» вхолостую (B-61).
    budget_day = re.search(
        r'(?ms)^\[models\.cloud\.budget\][^\[]*?^max_calls_per_day\s*=\s*(\d+)', base)
    assert budget_day, ("config.toml: max_calls_per_day не найден внутри "
                        "[models.cloud.budget] — тест протух, обнови шаблон")
    bad_window = base[:budget_day.start(1)] + "10" + base[budget_day.end(1):]
    check("конфиг: суточный лимит ниже оконного ловится",
          any("окно никогда не сработает" in p for p in problems_with(bad_window)))


# ── 6. бюджет облака: лимиты режут вызов ДО обращения к сети ────────────────
def test_cloud_budget(tmp: Path) -> None:
    import cloud as cloud_mod

    cfg = config_mod.load(HERE / "config.toml", strict=False)
    db = tmp / "cloud.db"

    with Store(db) as store:
        client = cloud_mod.build(cfg, store)
        # Инвариант — «облако включается ЯВНО», а не «в этом репозитории оно выключено»:
        # владелец его включил, и проверять надо умолчание кода, а не текущее значение
        # в config.toml. Иначе тест начинает падать ровно тогда, когда всё работает.
        check("облако: по умолчанию (без models.cloud.enabled) выключено",
              not cloud_mod.Budget.from_cfg(
                  config_mod.Config({"models": {"cloud": {}}}, cfg.path)).enabled
              and not cloud_mod.Budget().enabled)

        client.budget.enabled = True
        client.providers.setdefault("zai", {})["key"] = "test-key"
        client.providers["zai"].setdefault("models", ["glm-5.2"])
        client.providers["zai"].setdefault("base_url", "https://api.z.ai/api/paas/v4")

        client.budget.max_calls_per_run = 0
        result = client.chat("run-1", "judge.cloud", "glm-5.2",
                             [{"role": "user", "content": "x"}])
        check("облако: лимит вызовов на прогон режет обращение",
              not result.ok and "на прогон" in result.error, result.error[:60])

        # Окно плана — главный стоп на подписке, он должен срабатывать раньше суточного.
        client.budget.max_calls_per_run = 5
        client.budget.max_calls_per_window = 0
        result = client.chat("run-2", "judge.cloud", "glm-5.2",
                             [{"role": "user", "content": "x"}])
        check("облако: окно плана режет обращение",
              not result.ok and "окно плана" in result.error, result.error[:60])

        client.budget.max_calls_per_window = 100
        client.budget.max_calls_per_day = 0
        result = client.chat("run-3", "judge.cloud", "glm-5.2",
                             [{"role": "user", "content": "x"}])
        check("облако: суточный лимит вызовов режет обращение",
              not result.ok and "суточный лимит вызовов" in result.error, result.error[:60])

        client.budget.max_calls_per_day = 100
        client.budget.max_usd_per_day = 0.000001
        client.pricing = {"glm-5.2": {"in_per_mtok": 1.0, "out_per_mtok": 3.0}}
        result = client.chat("run-4", "judge.cloud", "glm-5.2",
                             [{"role": "user", "content": "x"}])
        check("облако: денежный потолок режет обращение (модели вне подписки)",
              not result.ok and "$" in result.error, result.error[:60])

        # Модель, покрытая подпиской, имеет прайс 0 — денежный стоп по ней не срабатывает,
        # её держит окно. Иначе нулевой прайс молча блокировал бы весь Coding Plan.
        client.pricing = {}
        client.providers["zai"]["models"].append("glm-4.6")
        ok_budget, why = client.check_budget("run-5", "glm-4.6")
        check("облако: нулевой прайс не блокирует модель подписки", ok_budget, why[:60])

        # Отказы обязаны попадать в учёт: иначе неверный порог эскалации не видно.
        refused = store.q("SELECT refused FROM cloud_usage WHERE refused <> ''")
        check("облако: отказы по бюджету пишутся в cloud_usage", len(refused) == 4,
              f"записей: {len(refused)}")

        # Лимит частоты Gemini считается по собственному журналу — заголовков нет.
        client.providers["gemini"] = {"base_url": "https://x", "models": ["gemini-3.6-flash"],
                                      "key": "k", "timeout": 10}
        client.rate_limits = {"gemini": {"max_calls_per_2min": 0, "max_calls_per_30min": 10}}
        ok_rate, why = client.check_budget("run-6", "gemini-3.6-flash")
        check("облако: лимит частоты Gemini режет обращение",
              not ok_rate and "частоты gemini" in why, why[:60])

        # Шлюз (OpenRouter :free): суточный потолок — скользящие 24 ч по всем ушедшим запросам, удачным и нет;
        # отказ несёт retry_after до выхода старейшего запроса из окна, эскалация классифицирует его как квоту.
        import cloud_escalation as ce_mod
        client.providers["gateway"] = {"base_url": "https://x", "models": ["executive.deep"], "key": "k", "timeout": 10}
        client.rate_limits = {"gateway": {"max_requests_per_24h": 3}}
        now_ts = int(time.time())
        for i, (ok_flag, refused_why) in enumerate([(1, ""), (0, ""), (1, ""), (0, "бюджет")]):
            store.x("INSERT INTO cloud_usage (run_id, role, provider, model, ok, refused, error, created_at) "
                    "VALUES (?,?,?,?,?,?,?,?)", (f"gw-{i}", "x", "gateway", "executive.deep", ok_flag, refused_why, "",
                                                 now_ts - 3600 * (3 - i)))
        ok_day, why_day = client.check_budget("run-gw", "executive.deep")
        check("шлюз: суточный потолок запросов — включая неудачные, без отказов по бюджету",
              not ok_day and "3/3 запросов за 24 ч" in why_day, why_day[:80])
        retry = ce_mod.provider_reset(why_day, now=now_ts)
        check("шлюз: отказ по суточному потолку — квота с ожиданием до выхода старейшего запроса",
              ce_mod.classify(why_day) == ce_mod.QUOTA and retry is not None and 20 * 3600 < retry - now_ts <= 21 * 3600 + 5,
              f"{ce_mod.classify(why_day)} retry={None if retry is None else int(retry - now_ts)}")
        client.rate_limits = {"gateway": {"max_requests_per_24h": 4}}
        ok_more, _ = client.check_budget("run-gw2", "executive.deep")
        check("шлюз: ниже потолка — вызов разрешён", ok_more)

        # Неизвестная модель не должна молча уходить в сеть под чужим ключом.
        result = client.chat("run-7", "judge.cloud", "нет-такой-модели",
                             [{"role": "user", "content": "x"}])
        check("облако: необъявленная модель не вызывается",
              not result.ok and "не объявлена" in result.error, result.error[:60])

        # Инвариант — вызова нет, когда ключа нет НИ В ОДНОМ контуре. Пустой только
        # основной ключ отказом не является: при настроенном втором контуре
        # (General API) тот осознанно работает как основной — «подписки может не
        # быть вовсе» (available(), cloud.py). На машине с настроенным вторым
        # контуром без этой строки проверка уходила в сеть платным маршрутом
        # и падала на живом API вместо локального отказа (B-61).
        client.providers["zai"]["key"] = ""
        client.providers["zai"]["fallback"] = {}
        result = client.chat("run-8", "judge.cloud", "glm-5.2",
                             [{"role": "user", "content": "x"}])
        check("облако: без ключа вызова нет",
              not result.ok and "нет ключа" in result.error, result.error[:60])

    # 429 значит три разные вещи, и повторять имеет смысл ровно одну из них.
    check("облако: 429 «insufficient balance» = ошибка конфига, не лимит",
          cloud_mod.classify_429(429, "Insufficient balance or no resource package") == "no_balance")
    check("облако: 429 «overloaded» = повторяемая перегрузка",
          cloud_mod.classify_429(429, "The service may be temporarily overloaded") == "overloaded")
    check("облако: прочий 429 = исчерпанная квота окна",
          cloud_mod.classify_429(429, "rate limit reached for this plan") == "quota")
    # Параллельные полосы воркера: превышение одновременных запросов Z.AI — не окно подписки.
    check("облако: Z.AI 1302 (параллельность) = повторяемая перегрузка",
          cloud_mod.classify_429(429, '{"error":{"code":"1302","message":"High concurrency usage of this API"}}')
          == "overloaded")
    check("облако: Z.AI 1310 (недельный лимит) = квота",
          cloud_mod.classify_429(429, '{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted"}}')
          == "quota")

    # Прайс — единственное место, где считаются деньги; ошибка тут не видна никак иначе.
    usd = cloud_mod.estimate_usd({"m": {"in_per_mtok": 1.0, "out_per_mtok": 3.0}},
                                 "m", 1_000_000, 1_000_000)
    check("облако: расчёт стоимости корректен", abs(usd - 4.0) < 1e-9, f"${usd}")
    check("облако: модель вне прайса считается как 0 (лимиты по вызовам остаются)",
          cloud_mod.estimate_usd({}, "unknown", 10**6, 10**6) == 0.0)

    # Второй контур биллинга (General API рядом с подпиской): он платный, поэтому
    # включаться должен только на «кончилась квота»/«нет пакета» и только при явно
    # заданных потолках — И по вызовам, И по деньгам. Ошибка здесь = молчаливая трата.
    with Store(tmp / "cloud-fallback.db") as fb_store:
        fallback_client = cloud_mod.CloudClient(store=fb_store, providers={"zai": {
            "base_url": "https://api.z.ai/api/coding/paas/v4", "models": ["glm-5.2"],
            "key": "k", "timeout": 10,
            "fallback": {"base_url": "https://api.z.ai/api/paas/v4", "key": "k2",
                         "key_env": "ZAI_GENERAL_API_KEY", "when": ["quota", "no_balance"],
                         "max_calls_per_day": 3, "max_usd_per_day": 0.5,
                         "pricing": {"glm-5.2": {"in_per_mtok": 1.5, "out_per_mtok": 6.0}},
                         "label": "General API"},
        }})
        allowed = fallback_client._fallback_allowed                            # noqa: SLF001
        check("облако: второй контур включается на исчерпанной квоте",
              bool(allowed("zai", "quota", "glm-5.2")[0]))
        check("облако: второй контур НЕ включается на перегрузке провайдера",
              not allowed("zai", "overloaded", "glm-5.2")[0])

        # Прайс контура. На подписке модель стоит 0 (расход держит окно), на платном
        # маршруте — деньги: по общему прайсу платный вызов записался бы бесплатным,
        # и денежный потолок не сработал бы никогда.
        check("облако: прайс второго контура не смешивается с подписочным",
              bool(fallback_client.pricing_of("zai:fallback").get("glm-5.2"))
              and not fallback_client.pricing_of("zai"))
        fallback_client.record(
            "run-fb", "judge.cloud", "glm-5.2", "zai:fallback",
            cloud_mod.Completion(True, "ok", None, "glm-5.2", 0, 1_000_000, 1_000_000))
        spent = fallback_client.fallback_spent_today("zai")
        check("облако: расход второго контура считается отдельно от подписки",
              spent["calls"] == 1 and abs(spent["usd"] - 7.5) < 1e-6, str(spent))

        contour, why = allowed("zai", "quota", "glm-5.2")
        check("облако: исчерпанный денежный потолок закрывает платный маршрут",
              not contour and "бюджет" in why, why[:70])

        fallback_client.providers["zai"]["fallback"]["max_usd_per_day"] = 0
        contour, why = allowed("zai", "quota", "glm-5.2")
        check("облако: второй контур без денежного потолка не используется",
              not contour and "денежный потолок" in why, why[:70])

        # Нет прайса → цена вызова неизвестна → ограничивать деньги нечем: на платный
        # маршрут такая модель не уходит вовсе, вместо «уйдёт и запишется как $0».
        fallback_client.providers["zai"]["fallback"]["max_usd_per_day"] = 100.0
        fallback_client.providers["zai"]["fallback"]["pricing"] = {}
        contour, why = allowed("zai", "quota", "glm-5.2")
        check("облако: модель без прайса контура на платный маршрут не уходит",
              not contour and "прайс" in why, why[:70])

        fallback_client.providers["zai"]["fallback"]["max_calls_per_day"] = 0
        contour, why = allowed("zai", "quota", "glm-5.2")
        check("облако: второй контур без суточного потолка не используется",
              not contour and "потолок" in why, why[:60])
        fallback_client.providers["zai"]["fallback"]["key"] = ""
        check("облако: второй контур без своего ключа не существует",
              not fallback_client.fallback_of("zai"))


# ── 8. знания: каталог с пагинацией и kind-фильтром (v2-P1) ────────────────
def test_knowledge(tmp: Path) -> None:
    """v2-P1/Ф4: каталог корпуса с пагинацией и kind-фильтром, FTS-поиск не сломан.

    Проверяется через Api.knowledge на временной БД с фикстурой корпуса: SELECT уходит
    мимо LLM и Ollama, поэтому тест быстрый и герметичный.
    """
    import gateway as gw
    from context_service import upsert_doc

    db = tmp / "k.db"
    store = Store(db)
    docs = [
        ("d1", "rule", "Запрет body unknown", "контроллер DTO никогда не принимает body unknown"),
        ("d2", "rule", "HttpClientService вместо fetch", "raw fetch запрещён, используй HttpClientService"),
        ("d3", "skill", "Миграция Prisma", "каждая миграция проходит migrate dev и migrate deploy"),
        ("d4", "card", "Карточка борда X", "проработка постановки консилиумом"),
        ("d5", "done_md", "Закрытое: WhatsApp", "интеграция закрыта в 2026-06"),
    ]
    for doc_id, kind, title, content in docs:
        upsert_doc(store, doc_id, kind, title, content, module="test",
                   source_ref=f"test/{doc_id}")

    cfg = config_mod.load(HERE / "config.toml", strict=False)
    api = gw.Api(cfg, db_path=str(db))

    # каталог: полный обход итерациями page_size=2 даёт все 5 документов ровно по разу
    seen: list[str] = []
    page = 1
    while True:
        res = api.knowledge(query="", kind="", page=page, page_size=2)
        if res["mode"] != "catalog":
            check("знания: без q — режим каталога", False, res["mode"])
            break
        seen += [h["doc_id"] for h in res["hits"]]
        if page >= res["pages"]:
            break
        page += 1
    check("знания: пагинация покрывает весь корпус без дублей",
          sorted(seen) == sorted(d[0] for d in docs), f"{len(seen)} из {len(docs)}")

    # kind-фильтр: счётчики и состав совпадают с фикстурой
    res = api.knowledge(query="", kind="rule", page=1, page_size=100)
    check("знания: kind-фильтр режет каталог корректно",
          res["total"] == 2 and all(h["kind"] == "rule" for h in res["hits"]),
          f"total={res['total']}")

    # page_size выше потолка не проходит (аналог «findMany без take»)
    res = api.knowledge(query="", page=1, page_size=1000)
    check("знания: page_size жёстко ограничен сверху", len(res["hits"]) <= 100,
          f"вернулось {len(res['hits'])}")

    # FTS не сломан и тоже пагинируется
    res = api.knowledge(query="HttpClientService", page=1, page_size=50)
    check("знания: FTS-поиск работает и ранжирует",
          res["mode"] == "search" and res["total"] >= 1
          and any(h["doc_id"] == "d2" for h in res["hits"]),
          f"total={res.get('total')}")
    res = api.knowledge(query="", page=99)
    check("знания: страница за пределами — пустой список, не ошибка",
          res["hits"] == [] and res["page"] == 99)
    store.close()


def test_home_form(tmp: Path) -> None:
    """v2-Ф1/P2: главная форма — @-упоминания, черновик+enqueue.

    Черновик — ЛОКАЛЬНАЯ карточка (db='draft'), на доску не попадает; поэтому здесь достаточно
    Api.create_task на временной БД, без сети.
    """
    import gateway as gw

    db = tmp / "h.db"
    store = Store(db)
    for card_id, title in (
        ("c1", "Миграция на Connect RPC"),
        ("c2", "Миграция очередей на BullMQ v6"),
        ("c3", "FOO_BAR service"),
        ("c4", "FOOXBAR service"),
    ):
        store.upsert_card({
            "card_id": card_id, "db": "cards", "title": title, "url": f"https://x/{card_id}",
            "status": "новое", "priority": None, "severity": None, "task_type": None,
            "source": "test", "backlog_id": None, "modules": "[]", "tags": "[]",
            "half_baked": 0, "parent_card_id": None, "subtask_ids": "[]", "report": None,
            "body": "", "comments": "[]", "content_hash": sha16(title),
            "notion_edited_at": None, "fetched_at": now(),
        })

    cfg = config_mod.load(HERE / "config.toml", strict=False)
    api = gw.Api(cfg, db_path=str(db))

    # точное совпадение резолвится однозначно, даже если оно — префикс другого заголовка
    r = api.create_task("Точное совпадение", "текст", ["Миграция на Connect RPC"], "fast")
    check("главная: точное совпадение упоминания резолвится", r["ok"], r.get("error", ""))
    if r["ok"]:
        card = store.get_card(r["card_id"])
        linked = json.loads(card["linked_card_ids"] or "[]")
        check("главная: точное совпадение — верная карточка", linked == ["c1"], linked)

    # LIKE-фолбэк: подстрока, однозначно матчащая ровно одну карточку
    r = api.create_task("LIKE-фолбэк", "текст", ["BullMQ v6"], "fast")
    check("главная: LIKE-фолбэк резолвится, если однозначен", r["ok"], r.get("error", ""))
    if r["ok"]:
        linked = json.loads(store.get_card(r["card_id"])["linked_card_ids"] or "[]")
        check("главная: LIKE-фолбэк — верная карточка", linked == ["c2"], linked)

    # находка #2 (review-p2.md): `_` в упоминании — LIKE-wildcard SQLite, не литерал.
    # Без эскейпа "FOO_BAR" матчит и "FOO_BAR service", и "FOOXBAR service" (ложная
    # неоднозначность) — с эскейпом резолвится однозначно в c3.
    r = api.create_task("LIKE-эскейп: подчёркивание — не wildcard", "текст",
                         ["FOO_BAR"], "fast")
    check("главная: '_' в упоминании не матчит произвольный символ (эскейп LIKE)",
          r["ok"], r.get("error", ""))
    if r["ok"]:
        linked = json.loads(store.get_card(r["card_id"])["linked_card_ids"] or "[]")
        check("главная: LIKE-эскейп — верная карточка (c3, не c4)", linked == ["c3"], linked)

    # тот же эскейп — в автокомплите (gateway.py::cards_autocomplete), не только в create_task
    hits = api.cards_autocomplete(query="FOO_BAR")
    hit_ids = [h["card_id"] for h in hits]
    check("автокомплит: '_' в запросе не матчит произвольный символ (эскейп LIKE)",
          hit_ids == ["c3"], hit_ids)

    # находка N1 (review-p2.md, 3й проход): прямой вызов API мимо клиентского dedup в
    # pickMention() может повторить один card_id в links — сервер обязан дедуплицировать сам
    r = api.create_task("Дедуп упоминаний мимо UI", "текст",
                         ["Миграция на Connect RPC", "Connect RPC"], "fast")
    check("главная: повтор одной карточки в links дедуплицируется на сервере",
          r["ok"], r.get("error", ""))
    if r["ok"]:
        linked = json.loads(store.get_card(r["card_id"])["linked_card_ids"] or "[]")
        check("главная: дедуп упоминаний — ровно одна связь, не дубль", linked == ["c1"], linked)

    # неоднозначный LIKE (совпадает с обеими "Миграция...") — явная ошибка, не угадывание
    r = api.create_task("Битое упоминание — неоднозначность", "текст", ["Миграция"], "fast")
    check("главная: неоднозначное упоминание — явная ошибка, не молчаливый выбор",
          not r["ok"] and "Миграция" in r.get("error", ""), r)

    # несуществующее упоминание — та же явная ошибка, с именем упоминания в тексте
    r = api.create_task("Битое упоминание — нет карточки", "текст",
                         ["Такой карточки не существует"], "fast")
    check("главная: несуществующее упоминание — явная ошибка",
          not r["ok"] and "Такой карточки не существует" in r.get("error", ""), r)

    # пустой заголовок — отклоняется до записи в БД
    r = api.create_task("   ", "текст", [], "fast")
    check("главная: пустой заголовок отклоняется", not r["ok"], r)

    # больше 5 связей — отклоняется
    r = api.create_task("Слишком много связей", "текст", ["a", "b", "c", "d", "e", "f"], "fast")
    check("главная: больше 5 упоминаний отклоняется", not r["ok"], r)

    # успешный черновик реально стоит в очереди (не только записан как карточка)
    r = api.create_task("Черновик встаёт в очередь", "полный текст задачи", [], "fast")
    check("главная: черновик создан и поставлен в очередь", r["ok"] and r.get("run_id"), r)
    if r["ok"]:
        card = store.get_card(r["card_id"])
        check("главная: черновик — db='draft', source='home-form'",
              card["db"] == "draft" and card["source"] == "home-form", card)
        run = store.q1("SELECT status, track, profile FROM runs WHERE id = ?", (r["run_id"],))
        check("главная: прогон черновика queued/elaborate/fast",
              run is not None and run["status"] == "queued" and run["track"] == "elaborate"
              and run["profile"] == "fast", run)

        # антиспам: тот же title+body в течение 10s — повторная отправка отклоняется,
        # и не просто с ok=False — под отказом не должно появиться второго черновика/прогона
        cards_before = store.q1("SELECT COUNT(*) n FROM cards WHERE source='home-form'")["n"]
        runs_before = store.q1("SELECT COUNT(*) n FROM runs")["n"]
        r2 = api.create_task("Черновик встаёт в очередь", "полный текст задачи", [], "fast")
        cards_after = store.q1("SELECT COUNT(*) n FROM cards WHERE source='home-form'")["n"]
        runs_after = store.q1("SELECT COUNT(*) n FROM runs")["n"]
        check("главная: повторная отправка того же текста в течение 10s отклоняется",
              not r2["ok"], r2)
        check("главная: анти-спам не создаёт дубль черновика/прогона под отказом",
              cards_after == cards_before and runs_after == runs_before,
              (cards_before, cards_after, runs_before, runs_after))

        check("черновик: в работе (open_cards) и без источника доски",
              any(c["card_id"] == r["card_id"] for c in store.open_cards())
              and not (store.get_card(r["card_id"]) or {}).get("origin"))

        # планировщик: черновик не занимает окно и не всплывает как «зависший» в needs_human
        from planner_service import collect as planner_collect
        candidates, needs_human = planner_collect(cfg, store)
        draft_id = r["card_id"]
        check("планировщик: черновик не попадает ни в окно, ни в needs_human",
              draft_id not in [c.card_id for c in candidates]
              and draft_id not in [h["card_id"] for h in needs_human],
              draft_id)

    # находка #1 (review-p2.md): анти-спам должен закрывать TOCTOU-гонку, не только
    # «типичный» последовательный повтор. Две почти одновременные отправки одного и
    # того же title+body — как двойной клик или ретрай сети на реальном HTTP-сервере —
    # каждая на СВОЁМ соединении (api._store() открывает новое на каждый вызов, как и
    # на каждый реальный HTTP-запрос) должны дать РОВНО один черновик и один прогон.
    race_title, race_body = "Гонка: одновременная отправка", "текст гонки"
    barrier = threading.Barrier(2)
    race_results: list[dict] = []
    race_lock = threading.Lock()

    def _race_submit() -> None:
        barrier.wait()
        result = api.create_task(race_title, race_body, [], "fast")
        with race_lock:
            race_results.append(result)

    threads = [threading.Thread(target=_race_submit) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    race_hash = sha16(race_title + race_body)
    race_cards = store.q(
        "SELECT card_id FROM cards WHERE db='draft' AND content_hash = ?", (race_hash,))
    race_runs = store.q(
        "SELECT id FROM runs WHERE card_id = ?",
        (race_cards[0]["card_id"] if race_cards else "",))
    oks = [x for x in race_results if x["ok"]]
    check("гонка: конкурентная отправка — ровно один успех из двух", len(oks) == 1,
          race_results)
    check("гонка: конкурентная отправка — ровно один черновик в БД (TOCTOU закрыт)",
          len(race_cards) == 1, race_cards)
    check("гонка: конкурентная отправка — ровно один прогон поставлен в очередь",
          len(race_runs) == 1, race_runs)

    store.close()


def test_linked_ids_robustness() -> None:
    """Находка #3 (review-p2.md, 2й проход): `_linked_ids` обязан молча выключаться на
    ЛЮБОМ мусоре в колонке `linked_card_ids`, не только на битом/не-списочном JSON —
    список с не-строковыми элементами (`[[1,2]]`) раньше проходил `isinstance(list)` и
    падал на bind-параметре одним уровнем ниже, в `store.get_card()`."""
    import retrieval

    cases = [
        (None, []),
        ("", []),
        ("не json вообще", []),
        ("null", []),
        ("{}", []),
        ("[1, 2, 3]", []),               # список, но не строки — не годится как card_id
        ('[[1, 2], [3, 4]]', []),        # вложенные списки — сама находка #3
        ('["c1", 2, "c2"]', ["c1", "c2"]),  # смешанный — валидные строки сохраняются
        ('["c1", "c2"]', ["c1", "c2"]),
    ]
    for raw, expected in cases:
        got = retrieval.Retriever._linked_ids({"linked_card_ids": raw})
        check(f"_linked_ids: {raw!r} → {expected!r} без исключения", got == expected, got)


def test_planner(tmp: Path) -> None:
    import planner_service as planner

    cfg = config_mod.load(HERE / "config.toml", strict=False)
    db = tmp / "planner.db"

    def add(store, card_id, db_name, *, title="карточка", severity=None, priority=None,
            half_baked=0, status="открыто", modules=("backend",), readiness=0.8,
            est="S", parent=None, subtasks=(), with_run=True):
        store.upsert_card({
            "card_id": card_id, "db": db_name, "title": title, "url": "",
            "status": status, "priority": priority, "severity": severity,
            "task_type": None, "source": None, "backlog_id": card_id,
            "modules": json.dumps(list(modules)), "tags": "[]",
            "half_baked": half_baked, "parent_card_id": parent,
            "subtask_ids": json.dumps(list(subtasks)), "report": None, "body": "",
            "comments": "[]", "content_hash": sha16(card_id),
            "notion_edited_at": None, "fetched_at": int(time.time()),
            "origin": "tboards", "ticket": None, "board_task_id": card_id, "is_final": 0,
        })
        if not with_run:
            return
        run_id = store.enqueue(card_id, dedupe=False)
        store.x("UPDATE runs SET status='done', payload=?, readiness=?, finished_at=? "
                "WHERE id=?",
                (json.dumps({"readiness": readiness, "touched": {"modules": list(modules)},
                             "decomposition": [{"id": "1", "what": "x", "files": ["a.ts"],
                                                "est": est}],
                             "open_questions": []}, ensure_ascii=False),
                 readiness, int(time.time()), run_id))

    with Store(db) as store:
        add(store, "bug-low", "bugs", severity="low", readiness=0.2, est="S")
        add(store, "task-p0", "tasks", priority="P0", readiness=0.95, est="S")
        add(store, "bug-crit", "bugs", severity="critical", readiness=0.5, est="S")
        add(store, "hb", "tasks", priority="P0", half_baked=1, readiness=0.9)
        add(store, "wip", "tasks", priority="P3", status="в работе", readiness=0.3, est="S")
        add(store, "no-payload", "tasks", priority="P1", with_run=False)

        items, needs_human = planner.collect(cfg, store)
        ids = {i.card_id for i in items}
        check("планировщик: half-baked не попадает в кандидаты", "hb" not in ids)
        check("планировщик: half-baked уходит человеку",
              any(e["card_id"] == "hb" for e in needs_human))
        check("планировщик: непроработанная карточка уходит человеку",
              "no-payload" not in ids and any(e["card_id"] == "no-payload"
                                              for e in needs_human))

        deps = planner.dependency_map(items)
        planner.score_items(cfg, items, deps)
        by_id = {i.card_id: i for i in items}
        check("планировщик: `в работе` закрепляется в верхнем тире",
              by_id["wip"].tier == 0, f"tier={by_id['wip'].tier}")
        check("планировщик: critical-ошибка в верхнем тире",
              by_id["bug-crit"].tier == 0)
        check("планировщик: задача P0 не поднимается в тир ошибок",
              by_id["task-p0"].tier == 1)

        day = date_cls(2026, 8, 14)
        intervals = planner.free_intervals(cfg, day)
        check("планировщик: перерыв разрезает окно на два интервала",
              len(intervals) == 2, f"интервалов: {len(intervals)}")

        ordered, cyclic = planner.toposort(items, deps)
        check("планировщик: топосорт не терял элементы",
              len(ordered) + len(cyclic) == len(items),
              f"{len(ordered)}+{len(cyclic)} из {len(items)}")

        placed, overflow = planner.pack(cfg, ordered, intervals)
        placed_ids = [i.card_id for i in placed]
        check("планировщик: задача не обгоняет ошибку и закреплённое",
              placed_ids and placed_ids[0] in {"wip", "bug-crit"},
              f"первый: {placed_ids[0] if placed_ids else '—'}")
        check("планировщик: всё размещённое имеет время",
              all(i.start and i.end for i in placed))
        # focus_ratio 0.7: пункт на 30 продуктивных минут занимает ~43 минуты стены.
        if placed:
            first = placed[0]
            start_m = int(first.start[:2]) * 60 + int(first.start[3:])
            end_m = int(first.end[:2]) * 60 + int(first.end[3:])
            check("планировщик: focus_ratio растягивает время стены",
                  end_m - start_m > first.minutes,
                  f"{first.minutes}м продуктивных → {end_m - start_m}м стены")

    # Зависимости: подзадача обязана идти раньше родителя, цикл — человеку.
    with Store(tmp / "planner2.db") as store:
        add(store, "parent", "tasks", priority="P2", subtasks=["child"], est="S")
        add(store, "child", "tasks", priority="P3", parent="parent", est="S")
        items, _ = planner.collect(cfg, store)
        deps = planner.dependency_map(items)
        planner.score_items(cfg, items, deps)
        ordered, cyclic = planner.toposort(items, deps)
        order = [i.card_id for i in ordered]
        check("планировщик: подзадача раньше родителя",
              order.index("child") < order.index("parent") if len(order) == 2 else False,
              f"порядок: {order}")

    with Store(tmp / "planner3.db") as store:
        add(store, "a", "tasks", priority="P1", subtasks=["b"], est="S")
        add(store, "b", "tasks", priority="P1", subtasks=["a"], est="S")
        items, _ = planner.collect(cfg, store)
        deps = planner.dependency_map(items)
        planner.score_items(cfg, items, deps)
        ordered, cyclic = planner.toposort(items, deps)
        check("планировщик: цикл зависимостей не «разрывается на глазок»",
              len(cyclic) == 2 and not ordered,
              f"в цикле {len(cyclic)}, упорядочено {len(ordered)}")

    # Окно на один прогон (--from/--to из CLI и из UI). До этого аргументы принимал
    # супервизор, планировщик их не знал и падал на «unrecognized arguments»; теперь
    # проверяем и приём, и то, что кривое время не превращается в сутки напролёт.
    window_cfg = config_mod.load(HERE / "config.toml", strict=False)
    changed = planner.apply_window_override(window_cfg, "11:00", "15:00")
    day = planner.resolve_date(window_cfg)
    intervals = planner.free_intervals(window_cfg, day)
    check("планировщик: окно из аргументов применяется",
          changed == ["from", "to"] and window_cfg.get("planner.window.from") == "11:00"
          and intervals and intervals[0][0].strftime("%H:%M") == "11:00",
          f"{window_cfg.get('planner.window.from')}–{window_cfg.get('planner.window.to')}")

    def rejects(time_from: str, time_to: str) -> bool:
        try:
            planner.apply_window_override(
                config_mod.load(HERE / "config.toml", strict=False), time_from, time_to)
            return False
        except config_mod.ConfigError:
            return True

    check("планировщик: невалидное время окна отвергается", rejects("25:00", ""))
    check("планировщик: перевёрнутое окно отвергается", rejects("16:00", "15:00"))


# ── 8. обучение (§9) ────────────────────────────────────────────────────────
def test_learning(tmp: Path) -> None:
    """Инварианты, из-за которых обучение молча превращается в шум.

    Главный — идемпотентность: сервис проходит по вердиктам каждые полчаса, и если
    повторный проход начисляет те же α/β второй раз, надёжность модели растёт от
    частоты запуска сервиса, а не от качества её работы. Это не заметно ни по одному
    экрану — цифры выглядят правдоподобно и просто врут.
    """
    import learning as learning_mod

    db = tmp / "learning.db"
    with Store(db) as store:
        store.x("INSERT INTO cards (card_id, db, title, modules, content_hash, fetched_at) "
                "VALUES ('c1','bugs','тест','[\"backend\"]','h1',0)")
        store.x("INSERT INTO runs (id, card_id, track, profile, status, created_at) "
                "VALUES ('r1','c1','elaborate','fast','done',0)")
        for pid, model, role in (("r1:p1", "model-a", "proposer.code"),
                                 ("r1:p2", "model-b", "proposer.arch")):
            store.x("INSERT INTO proposals (id, run_id, role, model, payload, created_at) "
                    "VALUES (?,?,?,?,'{}',0)", (pid, "r1", role, model))
        store.x("INSERT INTO messages (run_id, round, role, model, ok, created_at) "
                "VALUES ('r1',4,'arbiter','model-c',1,0)")
        store.x("INSERT INTO verdicts (run_id, decision, comment, created_at) "
                "VALUES ('r1','accept','',0)")
        store.x("INSERT INTO verifications (run_id, proposal_id, checked, hallucinations, "
                "passed, created_at) VALUES ('r1','p1','[]','[{\"ref\":\"нет.ts\"}]',0,0)")

        first = learning_mod.apply_verdicts(store)
        halluc = learning_mod.apply_hallucinations(store)
        check("обучение: вердикт учтён", first["applied"] == 1, f"applied={first['applied']}")
        check("обучение: арбитр получает долю ответственности за результат",
              learning_mod.posterior(store, "model-c", "arbiter", "*") > 0.5,
              f"{learning_mod.posterior(store, 'model-c', 'arbiter', '*')}")
        check("обучение: модуль карточки и агрегат `*` обновляются оба",
              learning_mod.observations(store, "model-b", "proposer.arch", "backend") == 1.0
              and learning_mod.observations(store, "model-b", "proposer.arch", "*") == 1.0)
        check("обучение: галлюцинация начислена автору предложения",
              halluc["applied"] == 1
              and learning_mod.posterior(store, "model-a", "proposer.code", "*")
              < learning_mod.posterior(store, "model-b", "proposer.arch", "*"),
              f"a={learning_mod.posterior(store, 'model-a', 'proposer.code', '*')} "
              f"b={learning_mod.posterior(store, 'model-b', 'proposer.arch', '*')}")

        before = store.q("SELECT model, role, module, alpha, beta FROM model_stats "
                         "ORDER BY model, role, module")
        again = learning_mod.apply_verdicts(store)
        again_h = learning_mod.apply_hallucinations(store)
        after = store.q("SELECT model, role, module, alpha, beta FROM model_stats "
                        "ORDER BY model, role, module")
        check("обучение: повторный проход ничего не начисляет (идемпотентность)",
              before == after and again["applied"] == 0 and again_h["applied"] == 0,
              f"повторно применено {again['applied']}/{again_h['applied']}")

        cfg = config_mod.load(HERE / "config.toml", strict=False)
        cfg.data.setdefault("learning", {})["min_observations"] = 0
        weight_bad = learning_mod.reviewer_weight(store, cfg, "model-a", "proposer.code", "*")
        weight_good = learning_mod.reviewer_weight(store, cfg, "model-b", "proposer.arch", "*")
        check("обучение: ненадёжный рецензент весит меньше надёжного",
              weight_bad < weight_good, f"{weight_bad} < {weight_good}")
        check("обучение: вес неизвестной модели ровно 1.0 (механизм не искажает пустоту)",
              learning_mod.reviewer_weight(store, cfg, "model-x", "proposer.code", "*") == 1.0)

        cfg.data["learning"]["min_observations"] = 3
        check("обучение: ниже порога наблюдений вес не применяется",
              learning_mod.reviewer_weight(store, cfg, "model-a", "proposer.code", "*") == 1.0)

        # Откат надёжности: репутация модели должна переезжать в роль, где её не мерили,
        # иначе перестановка ролей рекомендует того, о ком ничего не известно. Проверяется
        # ПОРЯДОК, а не абсолютное значение: важно, что модель с худшей историей и в новой
        # роли оценена ниже, а не то, в какое число это вылилось на трёх сигналах.
        cfg.data["learning"]["min_observations"] = 1
        worse, basis_worse = learning_mod.backoff_posterior(store, "model-a", "arbiter", "*", 1.0)
        better, basis_better = learning_mod.backoff_posterior(store, "model-b", "arbiter", "*", 1.0)
        check("обучение: неизмеренная роль наследует репутацию модели, а не приор",
              basis_worse == "model" and basis_better == "model" and worse < better,
              f"model-a={worse} ({basis_worse}) < model-b={better} ({basis_better})")
        check("обучение: совсем неизвестная модель откатывается к приору 0.5",
              learning_mod.backoff_posterior(store, "model-x", "arbiter", "*", 1.0)
              == (0.5, "prior"))

        # Хук вердикта (его дёргают и UI, и `supervisor.py verdict`): к моменту вызова
        # всё по прогону уже учтено фоновым проходом, поэтому хук обязан быть пустой
        # операцией, а не вторым начислением. Проверяется именно та функция, что стоит
        # в обоих местах, а не её половины.
        hook = learning_mod.apply_run(store, "r1")
        check("обучение: хук вердикта не начисляет учтённое повторно",
              hook["verdicts"]["applied"] == 0 and hook["hallucinations"]["applied"] == 0
              and hook["verdicts"]["skipped"] == 1,
              f"{hook['verdicts']} / {hook['hallucinations']}")

        # Дрейф рубрики: причин меньше порога — предложений быть не должно, и это
        # должно быть сказано явно, а не выглядеть как «дрейфа нет».
        drift = learning_mod.cluster_reject_reasons(cfg, store, client=None)
        check("обучение: без достаточного числа причин рубрика не трогается",
              drift["suggestions"] == 0 and "порог" in drift.get("reason", ""),
              drift.get("reason", ""))

    # Вкладка «Качество»: таблица надёжности — вся сетка «модель × роль» из доски ролей, а не только пары,
    # по которым уже был сигнал. Без наблюдений — приор 1/1 с пометкой prior; учтённые пары не теряются.
    import gateway as gw
    ld = gw.Api(cfg, db_path=str(db)).learning("*")
    pairs = {(r["model"], r["role"]) for r in ld["reliability"]}
    grid = {(c["model"], role) for role, cands in ld["role_board"]["roles"].items() for c in cands}
    priors = [r for r in ld["reliability"] if r.get("prior")]
    check("обучение: в таблице надёжности все пары «модель × роль» доски ролей",
          grid <= pairs and len(pairs) == len(ld["reliability"]),
          f"нет {len(grid - pairs)} пар; строк {len(ld['reliability'])}, уникальных {len(pairs)}")
    check("обучение: пары без наблюдений — приор 1/1, учтённые не помечены приором",
          bool(priors) and all(r["alpha"] == 1.0 and r["beta"] == 1.0 and r["observations"] == 0.0
                               and r["reliability"] == 0.5 for r in priors)
          and any(not r.get("prior") and r["observations"] > 0 for r in ld["reliability"]),
          f"приоров {len(priors)} из {len(ld['reliability'])}")


def test_rubric_dedup(tmp: Path) -> None:
    """Дедупликация предложений дрейфа рубрики (§9, механизм 4).

    Локальная модель формулирует один дефект десятью способами. Без смысловой
    дедупликации вкладка «Качество» превращается в простыню переформулировок —
    фактический случай 2026-09-02: 65 предложений, большинство — вариации четырёх тем.
    """
    import learning as learning_mod

    db = tmp / "rubric.db"
    with Store(db) as store:
        store.x(
            "INSERT INTO rubric_suggestions (cluster_key, pattern, suggestion, target, "
            "hits, evidence, model, status, created_at, updated_at) "
            "VALUES (?,?,?,?,?,'[]','m','new',0,0)",
            ("k1", "Коммуникация моделей", "Только русский и английский языки",
             "prompts/critic", 3))

        dup = learning_mod.suggestion_duplicate(
            store, "prompts/critic", "Не корректная коммуникация моделей",
            "Коммуникация только на русском и английском языках")
        check("дрейф: переформулировка известного дефекта — дубль",
              dup is not None and dup["id"] == 1)

        fresh = learning_mod.suggestion_duplicate(
            store, "prompts/critic", "Срез индекса RAG молча выпадает из поиска",
            "Требовать реакцию на ошибку поиска")
        check("дрейф: новый дефект дублем не считается", fresh is None)

        other = learning_mod.suggestion_duplicate(
            store, "prompts/arbiter", "Не корректная коммуникация моделей",
            "Только русский и английский языки")
        check("дрейф: другая мишень — не дубль (правки разных промптов)", other is None)

    # 2026-10-14: 42 «новых» предложения оказались темами («Проблемы с качеством решений…», hits 77) и списками
    # мишеней одной строкой. Мишень — одна из перечня; категория и список мишеней — не дефект, не записываются.
    check("дрейф: мишень из списка через запятую — первая валидная",
          learning_mod.normalize_target("prompts/proposer.code, prompts/arbiter") == "prompts/proposer.code"
          and learning_mod.normalize_target("critic") == "prompts/critic"
          and learning_mod.normalize_target("что-то своё") == "rubric")
    check("дрейф: категория и список мишеней — не дефект; конкретный дефект — да",
          not learning_mod.actionable_pattern("Проблемы с качеством решений и проработкой задачи")
          and not learning_mod.actionable_pattern("[prompts/proposer.code, prompts/proposer.arch]")
          and not learning_mod.actionable_pattern("Система ушла не туда / не выполнена задача")
          and learning_mod.actionable_pattern("Воздержание при расхождении файлов, хотя файл назван в постановке"))
    check("дрейф: мишень без регистра, с двоеточием и по-русски",
          learning_mod.normalize_target("Mechanism: раунд сверки") == "mechanism"
          and learning_mod.normalize_target("механизм") == "mechanism")
    check("дрейф: короткий дефект и дефект с путём промпта — не шум; перечень мишеней — шум",
          learning_mod.actionable_pattern("Локали da/no в nginx")
          and learning_mod.actionable_pattern("prompts/arbiter требует «оба варианта» вместо значения")
          and not learning_mod.actionable_pattern("prompts/proposer.code, prompts/arbiter"))
    lines, dropped = learning_mod._fit_lines(["x" * 100] * 10, 350)
    check("дрейф: причины кластеризатору — в пределах окна модели, отброшенное посчитано",
          len(lines) == 3 and dropped == 7 and learning_mod._fit_lines(["x" * 900], 10)[0] == ["x" * 900])
    check("дрейф: «Проблема с …»/«Качество решения …» с причиной — дефект, перечень тем — категория",
          learning_mod.actionable_pattern("Качество решения падает при обрезке постановки")
          and learning_mod.actionable_pattern("Проблема с таймаутом слота: дедлайн истекает до рецензий")
          and learning_mod.actionable_pattern("Проблема с обрезкой постановки до 940 символов")
          and not learning_mod.actionable_pattern("Проблемы с hh.ru и шаблонами сообщений")
          and not learning_mod.actionable_pattern("Проблемы с DAMS RAG и коммуникацией моделей"))

    class _Cfg:
        def get(self, key, default=None):
            return {"learning.rubric_drift_suggest_after": 2, "learning.cluster_model": "fake"}.get(key, default)

        def roles(self, _profile):
            return {}

    seen_user: list[str] = []

    class _Client:
        def alive(self):
            return True

        def chat(self, model, messages, **_kw):
            seen_user.append(messages[-1]["content"])
            return SimpleNamespace(ok=True, error="", data={"clusters": [
                {"pattern": "Проблемы с качеством решений", "target": "prompts/arbiter",
                 "suggestion": "думать лучше", "run_ids": ["r1", "r2"]},
                {"pattern": "Воздержание при расхождении файлов, хотя файл назван в постановке",
                 "target": "mechanism, prompts/arbiter", "suggestion": "раунд сверки до воздержания",
                 "run_ids": ["r1", "r2"]},
            ]})

    with Store(tmp / "rubric-gen.db") as store:
        for rid in ("r1", "r2"):
            store.x("INSERT INTO runs (id, card_id, status, outcome) VALUES (?, 'c', 'abstained', ?)",
                    (rid, "модели поняли задачу по-разному (совпадение файлов 0.00 < 0.25)"))
            store.x("INSERT INTO verdicts (run_id, decision, comment, created_at) VALUES (?, 'reject', ?, 0)",
                    (rid, "файл назван в постановке, расходиться не в чем"))
        res = learning_mod.cluster_reject_reasons(_Cfg(), store, client=_Client())
        rows = store.q("SELECT pattern, target FROM rubric_suggestions")
        check("дрейф: кластеризатор видит исход прогона; тема отброшена, дефект записан с одной мишенью",
              res.get("skipped_generic") == 1 and len(rows) == 1 and rows[0]["target"] == "mechanism"
              and "исход: воздержание" in (seen_user[0] if seen_user else ""), f"{res} {rows}")
        skipped_ev = store.q1("SELECT ref FROM events WHERE kind = 'rubric.skipped_generic'") or {}
        check("дрейф: отброшенная тема видна в ленте, а не теряется молча", skipped_ev.get("ref") == "1", str(skipped_ev))



def test_child_env() -> None:
    """Супервизор не передаёт детям `MallocStackLogging*` (шум в council.log на macOS), остальное — как есть."""
    import supervisor
    env = supervisor.child_env({"MallocStackLogging": "0", "MallocStackLoggingNoCompact": "1",
                                "MallocNanoZone": "0", "PATH": "/usr/bin"})
    check("супервизор: MallocStackLogging* не доходят до детей, прочее окружение сохраняется",
          env == {"MallocNanoZone": "0", "PATH": "/usr/bin"})


def test_foreign_script() -> None:
    """Языковой гейт (textutil): ловит украинский/казахский/китайский; не ловит формулы, иконки, имена и цитаты
    из постановки (GLM-ревью #155: одна буква «і» в процитированном заголовке — не нарушение)."""
    import textutil
    has = textutil.has_foreign_script
    check("язык: украинский, казахский, китайский, греческое слово — ловятся",
          has("налаштування інтеграції та підключення") and has("Ответ: 导致了") and has("Қазақ тілі")
          and has("слово λόγος в тексте"))
    check("язык: русский с путями и ё, формулы Δ/α, иконка шрифта, одно имя — не нарушение",
          not has("Ёлка: apps/backend/src/x.ts и turbo run test:run") and not has("порог Δ=0.20 при α=0.05")
          and not has("иконка \ue001 в меню") and not has("офис в Мінск"))
    check("язык: цитата из постановки — не нарушение, своё — нарушение",
          not has("Карточка «Налаштування інтеграції» — про токены", allowed="Налаштування інтеграції")
          and has("Логіка під капотом: працює", allowed="Налаштування інтеграції"))


def test_role_board(tmp: Path) -> None:
    """«Кому какая роль» (2026-10-15): кандидаты из всех ростеров и статистики, облако/локально по ростеру
    провайдеров, текущие назначения, модель без данных — в конце; ростер GLM 5.x переставляется как профиль."""
    import learning as learning_mod

    class _Cfg:
        data = {"models": {"cloud": {"providers": {"zai": {"models": ["glm-5", "glm-5.2"]}}},
                           "glm_all": {"models": {"proposer.code": "glm-5", "proposer.arch": "glm-5.2",
                                                  "arbiter": "glm-5.2"}}},
                "learning": {"min_observations": 3}}

        def get(self, key, default=None):
            node = self.data
            for part in key.split("."):
                if not isinstance(node, dict) or part not in node:
                    return default
                node = node[part]
            return node

        def roles(self, profile):
            if profile == "fast":
                return {"proposer.code": "qwen2.5:7b", "proposer.arch": "glm4:latest", "arbiter": "glm4:latest"}
            raise learning_mod.config_mod.ConfigError(profile)

    cfg = _Cfg()
    with Store(tmp / "role-board.db") as store:
        for model, role, a, b in (("glm4:latest", "proposer.arch", 2, 9), ("glm-5", "proposer.arch", 7, 2),
                                  ("qwen2.5:7b", "proposer.code", 6, 3)):
            store.x("INSERT INTO model_stats (model, role, module, alpha, beta, updated_at) VALUES (?, ?, '*', ?, ?, 0)",
                    (model, role, a, b))
        board = learning_mod.role_board(cfg, store)
        arch = board["roles"]["proposer.arch"]
        check("роли: облако/локально — по ростеру провайдеров, не по имени (glm4:latest — локальная)",
              {x["model"]: x["cloud"] for x in arch}.get("glm4:latest") is False
              and {x["model"]: x["cloud"] for x in arch}.get("glm-5") is True)
        check("роли: лучший по данным — первым, где играет сейчас — отмечено; без данных — в конце",
              arch[0]["model"] == "glm-5" and arch[0]["in"] == []
              and next(x for x in arch if x["model"] == "glm4:latest")["in"] == ["fast"]
              and arch[-1]["basis"] == "prior", [(x["model"], x["basis"]) for x in arch])
        check("роли: ростер GLM 5.x — в досках вместе с профилями", board["rosters"].get("GLM 5.x", {}).get(
            "arbiter") == "glm-5.2")
        rec = board.get("glm_swap") or {}
        check("роли: перестановка ростера GLM 5.x — отдельным полем, без автоприменения",
              rec.get("available") is True and rec.get("applied") is False
              and rec["current"] == {"proposer.code": "glm-5", "proposer.arch": "glm-5.2"}, str(rec)[:300])
        same = all(learning_mod._board_posterior(
            {(r["model"], r["role"], r["module"]): (float(r["alpha"]), float(r["beta"]))
             for r in store.q("SELECT * FROM model_stats")}, m, r, "*", 3)[:2]
            == learning_mod.backoff_posterior(store, m, r, "*", 3)
            for m in ("glm4:latest", "glm-5", "qwen2.5:7b", "glm-5.2") for r in learning_mod.BOARD_ROLES)
        check("роли: оценка в памяти совпадает с backoff_posterior (без запроса на каждую пару)", same)


def test_model_reliability(tmp: Path) -> None:
    """Вкладка «Качество», таблица «модель/роль»: отказы квоты — отдельно от качества модели (2026-10-14:
    нули glm-5.x по 1017/762/339 вызовам были целиком HTTP 429 code 1310), время — только по успешным, окно."""
    import gateway
    now_ts = int(time.time())
    with Store(tmp / "reliability.db") as store:
        rows = [("glm-5", "proposer.code", 0, "", 0, now_ts)] * 3 + [
            ("glm-5", "proposer.code", 1, "{}", 2000, now_ts),
            ("glm4:latest", "arbiter", 0, "не JSON", 500, now_ts),
            ("glm4:latest", "arbiter", 1, "{}", 1000, now_ts - 40 * 86400)]
        for model, role, ok, resp, ms, ts in rows:
            store.x("INSERT INTO messages (run_id, round, role, model, prompt, response, ok, tokens_in, tokens_out, "
                    "ms, created_at) VALUES ('r', 1, ?, ?, 'p', ?, ?, 1, 10, ?, ?)", (role, model, resp, ok, ms, ts))
        for _ in range(3):
            store.x("INSERT INTO cloud_usage (run_id, role, provider, model, tokens_in, tokens_out, usd, ms, ok, "
                    "refused, error, created_at) VALUES ('r', 'proposer.code', 'zai', 'glm-5', 0, 0, 0, 5, 0, '', ?, ?)",
                    ('HTTP 429: {"error":{"code":"1310","message":"Weekly"}}', now_ts))
        week = {(r["model"], r["role"]): r for r in gateway.model_reliability(store, 7)["rows"]}
        glm, arb = week.get(("glm-5", "proposer.code")), week.get(("glm4:latest", "arbiter"))
        check("качество: отказы квоты видны отдельно, время — только по успешным",
              glm is not None and glm["ok"] == 1 and glm["no_answer"] == 3 and glm["ms_ok"] == 2000
              and glm["cloud_refusals"] == {"quota": 3}, str(glm))
        check("качество: неразобранный ответ — отдельно от «без ответа»; старое — вне окна",
              arb is not None and arb["n"] == 1 and arb["unparsed"] == 1 and arb["no_answer"] == 0, str(arb))
        full = {(r["model"], r["role"]): r for r in gateway.model_reliability(store, 0)["rows"]}
        check("качество: окно 0 — вся история", full[("glm4:latest", "arbiter")]["n"] == 2)
        check("качество: дошедшие до модели — 4 попытки − 3 отказа квоты = 1", glm["reached"] == 1, str(glm))

        # Наш лимит (окно плана в cloud.py) — не квота подписки; лишние строки облака (повтор, отказ без
        # сообщения) не уводят знаменатель ниже успешных; отказы ролей вне таблицы — отдельным числом.
        for refused in ("исчерпано окно плана: 501/500 вызовов за последние 10 ч",) * 4:
            store.x("INSERT INTO cloud_usage (run_id, role, provider, model, tokens_in, tokens_out, usd, ms, ok, "
                    "refused, error, created_at) VALUES ('r', 'proposer.code', 'zai', 'glm-5', 0, 0, 0, 0, 0, ?, ?, ?)",
                    (refused, refused, now_ts))
        store.x("INSERT INTO cloud_usage (run_id, role, provider, model, tokens_in, tokens_out, usd, ms, ok, "
                "refused, error, created_at) VALUES ('r', 'review.judge', 'zai', 'glm-5', 0, 0, 0, 0, 0, '', ?, ?)",
                ('HTTP 429: {"error":{"code":"1308","message":"5 hour"}}', now_ts))
        res = gateway.model_reliability(store, 7)
        glm = {(r["model"], r["role"]): r for r in res["rows"]}[("glm-5", "proposer.code")]
        check("качество: окно плана — наш лимит; знаменатель не ниже успешных; роли вне таблицы — отдельно",
              glm["cloud_refusals"] == {"quota": 3, "budget": 4} and glm["reached"] == 1
              and res["cloud_refusals_outside"] == 1 and res["cloud_refusals"] == {"quota": 3, "budget": 4},
              f"{glm} {res['cloud_refusals']} {res['cloud_refusals_outside']}")


def _spiral_payload(goal: str = "сделать X") -> dict:
    return {
        "abstain": False, "goal": goal, "non_goals": [],
        "decomposition": [{"id": "s1", "what": "шаг", "files": [], "est": "S",
                           "from": ["p1"]}],
        "touched": {"files": [], "routes": [], "prisma_models": [], "rpcs": [],
                    "modules": []},
        "risks": [], "acceptance": ["работает"], "verification_cmd": "turbo run typecheck",
        "open_questions": [], "confidence": 0.5,
    }


class _SpiralOllama:
    """Скриптованный клиент Ollama для спирали: отвечает по очереди."""

    def __init__(self, script: list):
        self.script = list(script)
        self.calls: list[tuple[str, str]] = []

    def chat(self, model, messages, **_kw):
        self.calls.append((model, (messages[-1]["content"] or "")[:60]))
        from types import SimpleNamespace
        if not self.script:
            return SimpleNamespace(ok=False, text="", data=None, error="скрипт исчерпан",
                                   ms=1, tokens_in=0, tokens_out=0)
        item = self.script.pop(0)
        return SimpleNamespace(ok=True, text=json.dumps(item, ensure_ascii=False),
                               data=item, error="", ms=1, tokens_in=0, tokens_out=0)

    def large_model(self, _model):
        import contextlib
        return contextlib.nullcontext()


def _spiral_council(tmp: Path, script: list):
    import council as council_mod

    cfg = config_mod.load(HERE / "config.toml", strict=False)
    cfg.data.setdefault("sources", {}).setdefault("rag", {})["db"] = str(tmp / "no-rag.db")
    store = Store(tmp / "spiral.db")
    client = _SpiralOllama(script)
    council = council_mod.Council(cfg, store, client, retriever=None,
                                  logger=lambda _msg: None)
    return council, store, client


def _drift_payload(goal: str, files: list[str]) -> dict:
    payload = _spiral_payload(goal)
    payload["touched"]["files"] = list(files)
    payload["decomposition"][0]["files"] = list(files)
    return payload


def test_drift_part2(tmp: Path) -> None:
    """Консилиум, часть 2 (2026-10-15): M2 сверка вместо воздержания при расхождении, M3 дожим 7–8/15, M6 языковой
    гейт, бюджет доп. раунда. Плюс инварианты ревью #159: незавершённый раунд откатывается, авторы видят исходные
    версии друг друга, потерявшие все файлы постановки исключаются из ворот и арбитража, переписанное перезаписано."""
    import council as council_mod
    import council_rounds as rounds
    from retrieval import Capsule
    import time as _t
    from types import SimpleNamespace

    Proposal = council_mod.Proposal
    F1, F2 = "infra/ai-council/council.py", "infra/ai-council/learning.py"     # существуют в репозитории
    check("доп. раунд: вид воздержания по причине",
          rounds.abstain_kind("модели поняли задачу по-разному (совпадение файлов 0.20 < 0.25)") == "divergence"
          and rounds.abstain_kind("модели разошлись в понимании ЦЕЛИ (совпадение goal 0.1)") == "divergence"
          and rounds.abstain_kind("лучшая оценка 8.0 ниже порога 9 из 15") == "below"
          and rounds.abstain_kind("ни одна модель не дала валидного предложения") == "")
    allowed = rounds.extra_round_allowed
    check("доп. раунд: запас не меньше потраченного (≥ 3 мин) плюс резерв арбитра",
          allowed(0, 420, now=100) and not allowed(0, 420, now=250) and not allowed(0, 150, now=10)
          and not allowed(0, 420, now=100, reserve=150))
    check("постановка: только существующие файлы от корня репозитория",
          rounds.statement_files(f"Поправить {F1}, apps/backend/src/nope.service.ts и docs/README.md.")
          == {F1, "docs/README.md"})

    capsule = Capsule(card_id="c1", pinned=f"Поправить {F1}: не хватает take")
    roles = {"proposer.code": "m-code", "proposer.arch": "m-arch", "proposer.skeptic": "m-sk"}
    review_ok = {"scores": {k: 2 for k in council_mod.RUBRIC_KEYS}, "blocking_objections": [],
                 "minor_objections": [], "converged": True}
    review_good = {"scores": {k: 3 for k in council_mod.RUBRIC_KEYS}, "blocking_objections": [],
                   "minor_objections": [], "converged": True}

    def run(council, run_id, props, reason, started=None, deadline=None):
        now = _t.time()
        return council._extra_round(run_id, capsule, props, roles, "*", reason,
                                    now if started is None else started, now + 600 if deadline is None else deadline)

    # M2: расхождение → сверка → оба взяли файл постановки → рецензии → воздержание снято; авторы видят ИСХОДНЫЕ
    # версии друг друга; переписанное перезаписано в proposals.
    council, store, client = _spiral_council(tmp, [
        _drift_payload("поправить take", [F1]), _drift_payload("поправить take", [F1]), review_ok, review_ok])
    props = [Proposal("p1", "proposer.code", "m-code", _drift_payload("рефакторинг", ["apps/a.ts"]), review_score=10),
             Proposal("p2", "proposer.arch", "m-arch", _drift_payload("другое", ["apps/b.ts"]), review_score=10)]
    for pr in props:
        store.x("INSERT INTO proposals (id, run_id, role, model, payload, grounded_score, review_score, total_score, "
                "created_at) VALUES (?, 'run-m2', ?, ?, '{}', 0, 0, 0, 0)", (f"run-m2:{pr.id}", pr.role, pr.model))
    abstain, after = run(council, "run-m2", props, council.should_abstain(props)[1])
    p2_prompt = (store.q1("SELECT prompt FROM messages WHERE run_id='run-m2' AND round=25 AND role='proposer.arch'")
                 or {}).get("prompt", "")
    stored = (store.q1("SELECT payload FROM proposals WHERE id='run-m2:p1'") or {}).get("payload", "")
    check("M2: расхождение → сверка → воздержание снято, предложения помечены «сверка»",
          not abstain and all(p.extra_round == "сверка" for p in props) and council._extra_kind == "сверка",
          f"{abstain} {after}")
    check("M2: второй автор видит исходную версию первого, а не уже переписанную (без «якоря»)",
          "apps/a.ts" in p2_prompt, p2_prompt[-400:])
    check("M2: переписанное перезаписано в proposals (детализация показывает то, что ушло в арбитраж)", F1 in stored)
    council.close()
    store.close()

    # M2, три автора: двое скопировали друг у друга файл мимо постановки — исключены из ворот и арбитража.
    council, store, client = _spiral_council(tmp, [
        _drift_payload("поправить take", [F1]), _drift_payload("поправить", ["apps/c.ts"]),
        _drift_payload("поправить", ["apps/c.ts"])] + [review_ok] * 6)
    props = [Proposal("p1", "proposer.code", "m-code", _drift_payload("a", ["apps/a.ts"]), review_score=10),
             Proposal("p2", "proposer.arch", "m-arch", _drift_payload("b", ["apps/b.ts"]), review_score=10),
             Proposal("p3", "proposer.skeptic", "m-sk", _drift_payload("c", ["apps/d.ts"]), review_score=10)]
    abstain, after = run(council, "run-m2c", props, council.should_abstain(props)[1])
    package = council._arbitration_package(capsule, props)
    check("M2: «согласие копированием» у двоих из трёх — они исключены, в арбитраж идёт только сохранивший постановку",
          not props[0].excluded and props[1].excluded and props[2].excluded
          and '"p1"' in package and '"p2"' not in package and '"p3"' not in package
          and all("выпал файл из постановки" in " ".join(p.objections) for p in props[1:]), f"{abstain} {after}")
    council.close()
    store.close()

    # M2: правка второго не удалась — перепроверен и перерецензирован только переписанный; у второго возражения R2 не
    # задвоились; расхождение осталось — воздержание с пометкой.
    council, store, client = _spiral_council(tmp, [_drift_payload("поправить take", [F1]), "сломано", review_ok])
    props = [Proposal("p1", "proposer.code", "m-code", _drift_payload("a", ["apps/a.ts"]), review_score=10),
             Proposal("p2", "proposer.arch", "m-arch", _drift_payload("b", ["apps/b.ts"]), review_score=10,
                      objections=["возражение R2"])]
    abstain, after = run(council, "run-m2d", props, council.should_abstain(props)[1])
    ver = store.q1("SELECT COUNT(*) n FROM verifications WHERE run_id='run-m2d'")["n"]
    check("M2: перепроверено только переписанное, у непереписанного возражения не задвоились",
          abstain and "(после сверки)" in after and ver == 1 and props[1].objections == ["возражение R2"]
          and len(client.calls) == 3, f"{after} ver={ver} calls={len(client.calls)}")
    council.close()
    store.close()

    # Время кончилось после правок — раунд откатывается: исходная причина с пометкой, оценки и файлы R2 на месте.
    council, store, client = _spiral_council(tmp, [_drift_payload("x", [F1]), _drift_payload("x", [F1])])
    props = [Proposal("p1", "proposer.code", "m-code", _drift_payload("a", ["apps/a.ts"]), review_score=10),
             Proposal("p2", "proposer.arch", "m-arch", _drift_payload("b", ["apps/b.ts"]), review_score=10)]
    reason = council.should_abstain(props)[1]
    t0, ticks = _t.time(), iter([0] + [10_000] * 20)
    saved_time = rounds.time
    rounds.time = SimpleNamespace(time=lambda: t0 + next(ticks))
    try:
        abstain, after = run(council, "run-m2t", props, reason, started=t0 - 10, deadline=t0 + 600)
    finally:
        rounds.time = saved_time
    check("доп. раунд: не уложился во время — откат, причина исходная с пометкой, без выдуманной «0.0 ниже порога»",
          abstain and after == f"{reason} (доп. раунд не завершён: время)"
          and [p.review_score for p in props] == [10, 10]
          and props[0].payload["touched"]["files"] == ["apps/a.ts"] and council._extra_kind == "", after)
    council.close()
    store.close()

    # M3: лучшая 8/15 → дожим по возражениям → повторная рецензия только лучшего → воздержание снято.
    council, store, client = _spiral_council(tmp, [_drift_payload("поправить take", [F1]), review_good])
    p1 = Proposal("p1", "proposer.code", "m-code", _drift_payload("поправить take", [F1]),
                  review_score=8.0, objections=["нет теста на take"])
    p2 = Proposal("p2", "proposer.arch", "m-arch", _drift_payload("поправить take", [F1]), review_score=5.0)
    abstain, after = run(council, "run-m3", [p1, p2], "лучшая оценка 8.0 ниже порога 9 из 15")
    prompt = (store.q1("SELECT prompt FROM messages WHERE run_id='run-m3' ORDER BY rowid LIMIT 1") or {}).get("prompt", "")
    check("M3: дожим 8/15 → автор видит возражения, повторная рецензия только лучшего → воздержание снято",
          not abstain and p1.extra_round == "дожим" and p1.total_score >= 9 and p2.total_score == 5.0
          and "ДОЖИМ" in prompt and "нет теста на take" in prompt and len(client.calls) == 2,
          f"{abstain} {after} {p1.total_score} {p2.total_score} {len(client.calls)}")
    council.close()
    store.close()

    # M3: повторная рецензия не состоялась — откат к оценке и возражениям R2, а не оценка верификатора.
    council, store, client = _spiral_council(tmp, [_drift_payload("поправить take", [F1]), "сломано"])
    p1 = Proposal("p1", "proposer.code", "m-code", _drift_payload("x", ["apps/a.ts"]),
                  review_score=8.0, objections=["нет теста на take"])
    p2 = Proposal("p2", "proposer.arch", "m-arch", _drift_payload("x", ["apps/a.ts"]), review_score=5.0)
    abstain, after = run(council, "run-m3f", [p1, p2], "лучшая оценка 8.0 ниже порога 9 из 15")
    check("M3: рецензент не ответил — откат: оценка 8.0, возражение и исходное предложение на месте",
          abstain and p1.review_score == 8.0 and p1.objections == ["нет теста на take"]
          and p1.payload["touched"]["files"] == ["apps/a.ts"] and p1.extra_round == "" and council._extra_kind == "",
          f"{abstain} {p1.review_score} {p1.objections}")
    council.close()
    store.close()

    council, store, client = _spiral_council(tmp, [])
    low = Proposal("p1", "proposer.code", "m-code", _drift_payload("x", ["apps/a.ts"]), review_score=6.0)
    lone = Proposal("p1", "proposer.code", "m-code", _drift_payload("x", ["apps/a.ts"]), review_score=8.0,
                    objections=["нет теста"])
    quiet = [Proposal("p1", "proposer.code", "m-code", _drift_payload("x", ["apps/a.ts"]), review_score=8.0),
             Proposal("p2", "proposer.arch", "m-arch", _drift_payload("x", ["apps/a.ts"]), review_score=5.0)]
    a0, _ = run(council, "run-m3b", [low], "лучшая оценка 6.0 ниже порога 9 из 15")
    a1, _ = run(council, "run-m3c", [lone], "лучшая оценка 8.0 ниже порога 9 из 15")
    a2, _ = run(council, "run-m3d", quiet, "лучшая оценка 8.0 ниже порога 9 из 15")
    check("M3: ниже 7, без второго рецензента и без возражений — дожима нет, вызовов нет",
          a0 and a1 and a2 and not client.calls, str(client.calls))
    council.close()
    store.close()

    # M6: ответ на украинском → повтор по-русски; цитата из постановки — не нарушение.
    council, store, client = _spiral_council(tmp, [
        {"blocking_objections": ["Логіка під капотом працює неправильно"], "minor_objections": [], "converged": False},
        {"blocking_objections": ["Логика под капотом работает неправильно"], "minor_objections": [],
         "converged": False}])
    council._lang_allowed = "Налаштування інтеграції"
    res = council._ask("run-m6", 2, "critic", "m-code", "sys", "user", council_mod.REVIEW_SCHEMA, 0.1)
    check("M6: чужой язык → один повтор, принят русский ответ",
          len(client.calls) == 2 and "Логика" in res.data["blocking_objections"][0], str(res.data))
    council.close()
    store.close()
    council, store, client = _spiral_council(tmp, [
        {"blocking_objections": ["карточка «Налаштування інтеграції» — про токены"], "minor_objections": [],
         "converged": False}])
    council._lang_allowed = "Налаштування інтеграції"
    council._ask("run-m6b", 2, "critic", "m-code", "sys", "user", council_mod.REVIEW_SCHEMA, 0.1)
    check("M6: цитата из постановки — не нарушение, повтора нет", len(client.calls) == 1)
    council.close()
    store.close()
    council, store, client = _spiral_council(tmp, [
        {"blocking_objections": ["Логіка під капотом працює"], "minor_objections": [], "converged": False}])
    council._ask("run-m6c", 4, "arbiter", "m-code", "sys", "user", council_mod.REVIEW_SCHEMA, 0.1, timeout=20)
    check("M6: на повтор нет времени (остаток таймаута < 30 с) — без повтора, роль отмечена для владельца",
          len(client.calls) == 1 and council._lang_failed == ["arbiter"], str(council._lang_failed))
    council.close()
    store.close()
    long_answer = {"blocking_objections": ["Логіка під капотом працює"] + ["пункт " * 300] * 4,
                   "minor_objections": [], "converged": False}
    council, store, client = _spiral_council(tmp, [long_answer])
    council._ask("run-m6d", 4, "arbiter", "m-code", "sys", "user", council_mod.REVIEW_SCHEMA, 0.1)
    check("M6: ответ длиннее показываемого — без повтора (обрезанный «закрыли» бы короче), роль отмечена",
          len(client.calls) == 1 and council._lang_failed == ["arbiter"])
    council.close()
    store.close()
    council, store, client = _spiral_council(tmp, [
        {"blocking_objections": ["Логіка під капотом працює", "второе возражение"], "minor_objections": [],
         "converged": False},
        {"blocking_objections": ["Логика под капотом"], "minor_objections": [], "converged": False}])
    res = council._ask("run-m6e", 2, "critic", "m-code", "sys", "user", council_mod.REVIEW_SCHEMA, 0.1)
    check("M6: повтор потерял пункт — не принят, остаётся исходный ответ",
          len(res.data["blocking_objections"]) == 2 and council._lang_failed == ["critic"])
    council.close()
    store.close()



def test_adversarial_spiral(tmp: Path) -> None:
    """R5 — адверсариальная спираль: сходимость по правилу, а не по настроению модели.

    Стоп-критерии проверяются кодом, и именно они тестируются: сошлось ли, когда
    адверсарий снял возражения; остановился ли цикл на повторе; не потерялось ли
    несошедшееся (остаток обязан уйти в open_questions); пропускается ли спираль
    для облачного арбитра без траты вызовов.
    """
    from types import SimpleNamespace
    import council as council_mod
    from retrieval import Capsule

    capsule = Capsule(card_id="c1", pinned="постановка задачи")
    roles = {"proposer.skeptic": "fake-skeptic", "arbiter": "fake-arbiter"}

    # 1. Сходимость на втором раунде: атака → ревизия → атака без возражений.
    council, store, client = _spiral_council(tmp, [
        {"blocking_objections": ["пункт s1 решает не ту цель — дрейф к рефакторингу"],
         "minor_objections": [], "converged": False},
        _spiral_payload(goal="исправленная цель"),
        {"blocking_objections": [], "minor_objections": ["мелочь"], "converged": True},
    ])
    merged, report = council.adversarial_spiral("run-spiral-1", capsule,
                                                _spiral_payload(), roles)
    check("спираль: сходится, когда адверсарий снял возражения",
          report["converged"] and report["rounds"] == 2
          and merged["goal"] == "исправленная цель",
          f"rounds={report['rounds']}, stop={report['stop_reason']}")
    check("спираль: атаки и ревизии идут РАЗНЫМИ моделями",
          [m for m, _ in client.calls] == ["fake-skeptic", "fake-arbiter", "fake-skeptic"],
          str([m for m, _ in client.calls]))
    check("спираль: сообщения спирали пишутся в транскрипт раундом 5",
          store.q1("SELECT COUNT(*) n FROM messages WHERE run_id='run-spiral-1' "
                   "AND round=5")["n"] == 3)
    council.close()
    store.close()

    # 2. Цикл: ревизия не устранила возражение, повтор распознан кодом; остаток
    #    обязан уйти в open_questions с префиксом «адверсарий:».
    council, store, _ = _spiral_council(tmp, [
        {"blocking_objections": ["в пункте s1 нет retry при ошибке 429 hh.ru"],
         "minor_objections": [], "converged": False},
        _spiral_payload(),
        {"blocking_objections": ["нет retry при 429 hh.ru в пункте s1 — не устранено"],
         "minor_objections": [], "converged": False},
        _spiral_payload(),
    ])
    merged, report = council.adversarial_spiral("run-spiral-2", capsule,
                                                _spiral_payload(), roles)
    check("спираль: повтор возражений останавливает цикл",
          not report["converged"] and "перестали меняться" in report["stop_reason"],
          f"stop={report['stop_reason']}")
    check("спираль: несошедшееся уходит в open_questions, а не исчезает",
          any(str(q).startswith("адверсарий:") for q in merged["open_questions"]),
          str(merged["open_questions"]))
    council.close()
    store.close()

    # 3. Адверсарий промолчал — прошлая версия решения сохранена.
    council, store, _ = _spiral_council(tmp, [])
    original = _spiral_payload(goal="оригинал")
    merged, report = council.adversarial_spiral("run-spiral-3", capsule, original, roles)
    check("спираль: молчание адверсария не портит решение",
          merged["goal"] == "оригинал" and not report["converged"]
          and "не дал валидного ответа" in report["stop_reason"],
          f"stop={report['stop_reason']}")
    council.close()
    store.close()

    # 4. Облачный арбитр — спираль пропускается, облачные вызовы не тратятся.
    council, store, client = _spiral_council(tmp, [])
    council.cloud = SimpleNamespace(provider_of=lambda m: "zai" if m == "glm-5" else "")
    merged, report = council.adversarial_spiral(
        "run-spiral-4", capsule, _spiral_payload(),
        {"proposer.skeptic": "fake-skeptic", "arbiter": "glm-5"})
    check("спираль: облачный ревизёр — пропуск без вызовов",
          not client.calls and "облачный" in report["stop_reason"]
          and merged["goal"] == "сделать X",
          f"stop={report['stop_reason']}, calls={len(client.calls)}")
    council.close()
    store.close()

    # 5. Чистые функции конвергенции.
    check("спираль: новые возражения — не повтор",
          not council_mod.objections_repeat(
              ["пункт 2 молчит о поведении при сбоях сети"],
              [["нет ретрая при 429 hh.ru"]]))
    check("спираль: дословный повтор распознан",
          council_mod.objections_repeat(
              ["нет ретрая при 429 hh.ru"], [["нет ретрая при 429 hh.ru"]]))
    check("спираль: переформулировка распознана как повтор",
          council_mod.objections_repeat(
              ["нет retry при ошибке 429 hh.ru"],
              [["retry при ошибке 429 hh.ru не описан"]]))
    check("спираль: пустая история — не повтор",
          not council_mod.objections_repeat(["любое возражение"], []))



def test_prisma_parser() -> None:
    """Парсер Prisma-схемы в граф (v2-P3, §3а) — по реальной schema.prisma, не по фикстуре:
    синтетический DSL-фрагмент не поймает то, из-за чего парсер обычно и ломается — реальные
    комбинации модификаторов/атрибутов, которых автор фикстуры не предусмотрел.
    """
    import graph_build

    if not graph_build.PRISMA_SCHEMA.is_file():
        # Хост без Prisma (дом слоя tAIBE: доски на Drizzle) — парсеру проверять нечего. В хосте с
        # монорепо apps/ отсутствие схемы — сбой: её переместили, и граф молча потерял модели.
        host_has_apps = (graph_build.REPO_ROOT / "apps").is_dir()
        check("prisma-парсер: schema.prisma найден" if host_has_apps else "prisma-парсер: хост без Prisma — пропуск",
              not host_has_apps, str(graph_build.PRISMA_SCHEMA))
        return

    result = graph_build._parse_prisma_models()
    nodes, edges, names = result["nodes"], result["edges"], result["model_names"]
    check("prisma-парсер: находит модели/enum'ы", len(names) > 100, f"{len(names)} моделей")
    check("prisma-парсер: узлы включают и модели, и enum'ы",
          {n["kind"] for n in nodes} <= {"prisma_model", "prisma_enum"}
          and "prisma_enum" in {n["kind"] for n in nodes},
          f"kinds={sorted({n['kind'] for n in nodes})}")
    check("prisma-парсер: id узла — 'prisma:<Имя>', без дублей",
          len({n["id"] for n in nodes}) == len(nodes)
          and all(n["id"] == f"prisma:{n['label']}" for n in nodes))
    check("prisma-парсер: рёбра связывают только известные узлы",
          all(e["source"].startswith("prisma:") and e["target"].startswith("prisma:")
              for e in edges if e["relation"] in ("prisma_relation", "contains")),
          "рёбра ссылаются на модель/enum, а не на произвольный текст поля")

    # Скалярные типы полей (String, Int, DateTime, ...) не должны попасть в граф как
    # узлы или как цель ребра — это самый вероятный сбой парсера при добавлении новой
    # модели: скаляр по имени похож на модель, если не сверяться со списком известных имён.
    scalar_as_target = graph_build._PRISMA_SCALARS & {e["target"].removeprefix("prisma:")
                                                        for e in edges}
    check("prisma-парсер: скалярные типы не становятся узлами графа",
          not scalar_as_target, f"утекли как узлы: {scalar_as_target}")


def _synthetic_graph() -> tuple[dict, dict]:
    """Три компоненты по 3 узла, рёбра размечены `relation` — общая заготовка для
    rel-фильтра и LOD-тестов ниже (не тянет 97 МБ реального graph.json — он в
    .gitignore и не гарантирован в CI)."""
    meta = {}
    for cid, members in (("a", ("a1", "a2", "a3")), ("b", ("b1", "b2", "b3")),
                          ("c", ("c1", "c2", "c3"))):
        for node_id in members:
            meta[node_id] = {"community": cid, "label": node_id}

    # внутри сообществ — полный набор связей двух типов; между сообществами — только "calls"
    edges = [("a1", "a2", "calls"), ("a2", "a3", "imports"), ("a1", "a3", "calls"),
             ("b1", "b2", "calls"), ("b2", "b3", "imports"), ("b1", "b3", "calls"),
             ("c1", "c2", "calls"), ("c2", "c3", "imports"), ("c1", "c3", "calls"),
             ("a1", "b1", "calls"), ("b2", "c2", "calls"), ("a3", "c3", "calls")]
    adj: dict[str, list] = {}
    for a, b, relation in edges:
        adj.setdefault(a, []).append((b, relation))
        adj.setdefault(b, []).append((a, relation))
    return meta, adj


def test_graph_relation_filter() -> None:
    """Фильтр связей на графе (v2-P3, §3б): срез должен оставаться связным ПО
    ОТФИЛЬТРОВАННЫМ рёбрам, а не превращаться в частично оторванные острова только
    потому, что убрали один тип связи из нескольких, которые держали компонент вместе.
    """
    import gateway

    meta, adj = _synthetic_graph()
    filtered = gateway.Api._filter_adj(adj, {"imports"})
    check("rel-фильтр: без фильтра adj не меняется",
          gateway.Api._filter_adj(adj, None) is adj)
    check("rel-фильтр: посторонний тип связи не проходит",
          all(relation == "imports" for links in filtered.values()
              for _, relation in links),
          "в отфильтрованном adj остались рёбра другого relation")
    # "imports" — ровно внутрикоммьюнити рёбра-цепочки (a2-a3, b2-b3, c2-c3): межкоммьюнити
    # переходы держатся только на "calls" и должны пропасть при фильтре на "imports".
    reachable = {node for node in filtered}
    communities_touched = {meta[n]["community"] for n in reachable}
    check("rel-фильтр: после фильтра на внутрикоммьюнити-связь сообщества не смешиваются",
          all(len({meta[other]["community"] for other, _ in filtered.get(n, ())} | {c}) == 1
              for c in communities_touched for n in reachable if meta[n]["community"] == c),
          "фильтр 'imports' случайно оставил межкоммьюнити ребро")


def test_graph_lod_communities() -> None:
    """LOD-агрегация по сообществам (v2-P3, §3в, решение D): сумма весов
    межкоммьюнити супер-рёбер должна совпадать с реальным числом межкоммьюнити рёбер —
    иначе агрегированная картинка «show everything» лжёт о плотности связей между
    областями, а это единственное, что она обязана показывать честно.
    """
    import gateway

    meta, adj = _synthetic_graph()
    nodes_out, edges_out = gateway.Api._graph_communities(meta, adj, None)
    check("LOD: число сообществ равно числу уникальных community-меток",
          len(nodes_out) == 3, f"{len(nodes_out)} сообществ")
    check("LOD: размер супер-узла равен числу участников",
          {n["community"]: n["size"] for n in nodes_out} == {"a": 3, "b": 3, "c": 3})

    true_inter = sum(1 for node_id, links in adj.items() for other, _ in links
                      if meta[node_id]["community"] != meta[other]["community"]) // 2
    check("LOD: сумма весов межкоммьюнити рёбер равна истинному числу межкоммьюнити рёбер",
          sum(e["weight"] for e in edges_out) == true_inter,
          f"агрегат={sum(e['weight'] for e in edges_out)} истина={true_inter}")

    filtered_edges = gateway.Api._graph_communities(meta, adj, {"imports"})[1]
    check("LOD: фильтр по relation применяется и к межкоммьюнити-агрегации",
          not filtered_edges, "'imports' не пересекает сообщества, супер-рёбер быть не должно")

    sub_meta, sub_adj = gateway.Api._community_subgraph(meta, adj, "a")
    check("LOD: drill-down в сообщество не тащит соседей из других сообществ",
          set(sub_meta) == {"a1", "a2", "a3"}
          and all(other in sub_meta for links in sub_adj.values() for other, _ in links))


def test_graph_communities_empty_filter_guard() -> None:
    """Ревью P3, находка #1 (CHANGES_REQUESTED, закрыта): `level=communities` должен
    отдавать `available: False` с понятной причиной, если фильтр по связи не оставил ни
    одного межобщинного ребра — а не молча рисовать облако несвязанных супер-узлов без
    единого ребра между ними (гард уже был у files/symbols, у communities — не было).
    """
    import gateway

    meta, adj = _synthetic_graph()
    cfg = config_mod.load(HERE / "config.toml", strict=False)
    api = gateway.Api(cfg, db_path=":memory:")
    fake_index = {
        "total_nodes": len(meta), "total_edges": sum(len(v) for v in adj.values()) // 2,
        "relations": ["imports", "calls"],
        "symbols": {"meta": meta, "adj": adj},
        "files": {"meta": meta, "adj": adj},
    }
    api._graph_index = lambda path: fake_index  # type: ignore[method-assign]
    api.cfg.path_of = lambda dotted, default="": Path(__file__)  # только is_file()==True

    d = api.graph(level="communities", rel="imports")
    check("communities + фильтр без межобщинных рёбер этого типа → available=False",
          d.get("available") is False, d)
    check("сообщение объясняет причину (не «граф пуст», сообщества-то есть)",
          "межобщин" in d.get("hint", ""), d.get("hint"))

    d_ok = api.graph(level="communities", rel="calls")
    check("communities + фильтр, у которого межобщинные рёбра есть → available=True",
          d_ok.get("available") is True and d_ok.get("edges"), d_ok)

    d_all = api.graph(level="communities")
    check("communities без фильтра — гард не срабатывает зря",
          d_all.get("available") is True, d_all)


def test_session_lifecycle(tmp: Path) -> None:
    """v2-P4/Ф2: сессия владельца — открытие → прогон прикрепляется → закрытие со
    свёрткой (роль extractor, здесь — фейковый клиент, детерминированно) → свёртка
    видна как pinned-блок retrieval следующей сессии И как corpus kind='session'.
    """
    import context_service
    from ollama import Completion
    from retrieval import Retriever

    class _FakeExtractor:
        def chat(self, model, messages, **kwargs):
            return Completion(True, "Разобрали тестовую карточку, вердикт accept.",
                              None, model, 1, 0, 0, "")

    db = tmp / "session.db"
    store = Store(db)
    cfg = config_mod.load(HERE / "config.toml", strict=False)

    session = store.open_session("P4 selftest")
    check("сессия: открытие создаёт запись со статусом open",
          session["status"] == "open" and session["id"].startswith("sess_"), session)

    run_id = store.enqueue("card-p4-selftest", track="elaborate", profile="fast", dedupe=False)
    store.claim_run("selftest-worker")
    store.finish_run(run_id, "done", "готово",
                     {"statement": {"goal": "проверить сессию P4"}}, 0.8, 0.9)
    attached = store.add_session_run_if_open(run_id)
    check("сессия: прогон прикрепляется к открытой сессии", attached == session["id"])

    runs = store.session_runs(session["id"])
    check("сессия: session_runs видит прикреплённый прогон",
          len(runs) == 1 and runs[0]["id"] == run_id, runs)

    closed = store.close_session_if_open(session["id"])
    check("сессия: close_session_if_open флипает open→closed", closed is True)
    check("сессия: повторное закрытие уже закрытой — no-op (False), не ошибка",
          store.close_session_if_open(session["id"]) is False)

    result = context_service.summarize_session(cfg, store, _FakeExtractor(), session["id"])
    max_tokens = int(cfg.get("council.session_context", {}).get("max_summary_tokens", 300))
    check("сессия: свёртка построена и уложилась в бюджет токенов",
          result is not None and result["tokens"] <= max_tokens, result)

    stored = store.get_session(session["id"])
    check("сессия: summary записан в sessions.summary", bool(stored and stored.get("summary")))

    doc = store.q1("SELECT * FROM corpus_meta WHERE doc_id = ?", (f"session:{session['id']}",))
    check("сессия: свёртка индексирована в corpus_meta как kind='session'",
          doc is not None and doc["kind"] == "session", doc)

    retriever = Retriever(cfg, store, _FakeExtractor())
    block = retriever.session_context_block()
    check("сессия: pinned-блок следующей сессии содержит свёртку закрытой",
          bool(block) and "1 карточка" in block and "accept" in block, block)
    retriever.close()

    # гейт выключен → поведение как до P4, ничего из вышеперечисленного не работает
    cfg_off = config_mod.load(HERE / "config.toml", strict=False)
    cfg_off.data.setdefault("council", {})["session_context"] = {"enabled": False}
    check("сессия: гейт выключен — summarize_session становится no-op",
          context_service.summarize_session(cfg_off, store, _FakeExtractor(),
                                            session["id"]) is None)
    store.close()


def test_open_session_race(tmp: Path) -> None:
    """v2-P4/Ф2 фикс (review-p4.md, находка #1, HIGH): `Api.open_session()` раньше
    делал check-then-act тремя отдельными вызовами store (SELECT прежней открытой →
    закрыть → INSERT новой) без общей транзакции — два параллельных
    `POST /api/sessions` (два потока `ThreadingHTTPServer`, каждый со своим
    sqlite3-соединением, как `Api._store()` открывает заново на каждый вызов)
    оба видели «нет открытой» и оба вставляли свою, давая ДВЕ одновременно
    `status='open'` строки без механизма самоизлечения. Тест воспроизводит ровно
    эту гонку на настоящем `gateway.Api.open_session()` (не на низкоуровневом
    примитиве в изоляции) — двумя потоками, каждый со своим соединением к одному
    файлу БД, синхронизированными `threading.Barrier`."""
    import gateway as gw

    db = tmp / "session_race.db"
    Store(db).close()  # создать файл + схему один раз, до гонки
    cfg = config_mod.load(HERE / "config.toml", strict=False)

    results: list[object] = [None, None]
    barrier = threading.Barrier(2)

    def worker(i: int) -> None:
        api = gw.Api(cfg, db_path=str(db))
        try:
            barrier.wait(timeout=5)
            results[i] = api.open_session(f"race-{i}")
        except Exception as exc:  # noqa: BLE001 — тест должен увидеть любой сбой, не только штатный
            results[i] = exc

    t1 = threading.Thread(target=worker, args=(0,))
    t2 = threading.Thread(target=worker, args=(1,))
    t1.start(); t2.start()
    t1.join(timeout=10); t2.join(timeout=10)

    check("сессия: гонка open_session — оба потока завершились без исключения",
          not any(isinstance(r, Exception) for r in results), results)

    store = Store(db)
    open_rows = store.q("SELECT * FROM sessions WHERE status = 'open'")
    closed_rows = store.q("SELECT * FROM sessions WHERE status = 'closed'")
    check("сессия: гонка open_session — ровно ОДНА открытая сессия на выходе (не две)",
          len(open_rows) == 1, open_rows)
    check("сессия: гонка open_session — вторая корректно закрыта, не потеряна и не зомби",
          len(closed_rows) == 1, closed_rows)
    store.close()


def test_mcp_server_registers_p4_tools() -> None:
    """v2-P4/Ф2: MCP-сервер поднимается по stdio и отдаёт все 4 новых инструмента
    в tools/list — без похода в БД (`initialize`/`tools/list` его не требуют), поэтому
    тест не трогает боевую БД и не поднимает gateway.py."""
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "mcp_server.py")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=str(HERE), text=True, bufsize=1,
    )
    try:
        proc.stdin.write(json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                      "clientInfo": {"name": "selftest", "version": "0"}},
        }) + "\n")
        proc.stdin.flush()
        init_line = proc.stdout.readline()
        proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}) + "\n")
        proc.stdin.flush()
        proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}) + "\n")
        proc.stdin.flush()
        list_line = proc.stdout.readline()
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    check("MCP: initialize отвечает без падения",
          bool(init_line) and json.loads(init_line).get("result") is not None)
    names = set()
    if list_line:
        tools = json.loads(list_line).get("result", {}).get("tools", [])
        names = {t["name"] for t in tools}
    expected = {"council_knowledge_search", "council_session_context",
               "council_card_runs", "council_graph_neighbors"}
    check("MCP: все 4 новых инструмента P4/Ф2 зарегистрированы",
          expected <= names, sorted(names))
    review_tools = {"council_review_queue", "council_review_start", "council_review_prepare",
                    "council_review_result", "council_review_decide", "council_review_config",
                    "council_queue_status", "council_queue_pause", "council_queue_resume"}
    check("MCP: инструменты ревью зарегистрированы", review_tools <= names,
          sorted(review_tools - names))


def test_review(tmp: Path) -> None:
    """Ревью-оркестрация: валидация настроек, политика вердикта (код, не модель), переход без записи на доску
    и атомарный захват очереди ревью."""
    import review_catalog as cat
    from review_engine import _RunState, decide
    from review_store import ReviewStore

    rs = ReviewStore(Store(tmp / "review.db"))
    check("ревью: засев — встроенные агенты, профили и доски",
          len(rs.agents()) == len(cat.BUILTIN_AGENTS) and len(rs.profiles()) >= 1
          and set(rs.boards()) == set(cat.BOARDS))
    check("ревью: доски по умолчанию — перевод выключен, подтверждение человека включено",
          all(not b["allow_transition"] and b["require_human_approval"] for b in rs.boards().values()))

    def raises(fn) -> bool:
        try:
            fn()
        except cat.ValidationError:
            return True
        return False

    check("ревью: переход в несуществующий статус доски отклонён",
          raises(lambda: rs.save_board("bugs", {"on_accept": "готово-готово"})))
    check("ревью: переход в тот же статус ревью отклонён",
          raises(lambda: rs.save_board("bugs", {"on_fail": "на ревью"})))
    check("ревью: ручной профиль без агентов отклонён",
          raises(lambda: rs.save_profile(None, "пустой", {"participant_mode": "MANUAL", "agents": []})))
    check("ревью: неизвестный метод отклонён",
          raises(lambda: rs.save_profile(None, "x", {"method": "MAGIC", "agents": ["code_reviewer"]})))
    clean = cat.clean_params({"temperature": "0.3", "rm_rf": 1, "top_k": "", "stop": "a|b"})
    check("ревью: белый список параметров модели (лишнее и пустое выкинуто)",
          clean == {"temperature": 0.3, "stop": ["a", "b"]}, clean)
    check("ревью: параметр вне диапазона отклонён",
          raises(lambda: cat.clean_params({"temperature": 9})))
    prof = rs.profile(None)
    saved = rs.save_profile(prof["id"], prof["name"], {**prof["spec"], "note": "v2"})
    check("ревью: сохранение профиля поднимает версию и пишет историю",
          saved["version"] == prof["version"] + 1 and len(rs.profile_versions(prof["id"])) >= 2)

    import selftest_review
    import selftest_review_policy
    selftest_review_policy.policy_checks(check)
    selftest_review.evidence_checks(check)
    selftest_review.consult_checks(check)
    selftest_review.team_checks(check, tmp, Store)
    selftest_review.e2e_checks(check, tmp, Store)

    import review_service as review_svc
    card0 = {"card_id": "c0", "board": "bugs", "title": "t0", "review_hash": "h", "comments": "[]"}
    rs.upsert_card(card0)
    rid0 = rs.enqueue(card0, rs.profile(None), "selftest", {})
    rs.finish(rid0, "done", "ACCEPT", 0.9, "ok", {})
    rs.set_transition(rid0, "none", "закрыто", "рекомендация", "ai")
    refused = review_svc.decide_transition(None, rs, rid0, True, "ui")
    check("ревью: перевод выключен политикой — применить нельзя даже из UI",
          refused.get("ok") is False and rs.run(rid0)["transition_state"] == "none", refused)
    rs.save_board("bugs", {**rs.boards()["bugs"], "allow_transition": True, "require_human_approval": False})
    rid_a = rs.enqueue(card0, rs.profile(None), "selftest", {})
    rs.finish(rid_a, "done", "ACCEPT", 0.9, "ok", {})
    review_svc.after_run(None, rs, rid_a, log=lambda *_: None)
    proposed = rs.run(rid_a)
    check("ревью: на доску не пишет — даже без подтверждения по политике переход только предлагается",
          proposed["transition_state"] == "proposed" and proposed["comment_state"] == "skipped", proposed)
    approved = review_svc.decide_transition(None, rs, rid_a, True, "mcp")
    check("ревью: «подтвердить» — состояние approved в базе и подсказка перенести карточку на доске",
          approved.get("state") == "approved" and rs.run(rid_a)["transition_state"] == "approved"
          and "перенесите" in str(approved.get("next")), approved)
    import review_stats
    check("ревью: approved — «согласен» для калибровки", review_stats.owner_label(rs.run(rid_a)) == "agree")
    rs.save_board("bugs", {**rs.boards()["bugs"], "allow_transition": False, "require_human_approval": True})
    card = {"card_id": "c1", "board": "bugs", "title": "t", "review_hash": "h", "comments": "[]"}
    rs.upsert_card(card)
    run_id = rs.enqueue(card, rs.profile(None), "selftest", {})
    first, second = rs.claim("w1"), rs.claim("w2")
    check("ревью: прогон захватывает ровно один воркер",
          first is not None and first["id"] == run_id and second is None)
    check("ревью: отмена идущего прогона — флаг, heartbeat его видит",
          rs.request_cancel(run_id) == "cancel_requested" and rs.heartbeat(run_id) is False)
    rs.s.close()


def test_headroom_compress_fallback() -> None:
    """v2-P4/Ф2: `/v1/compress` у Headroom требует недокументированный auth и имеет
    недокументированную схему тела (см. review) — `_maybe_compress` обязан деградировать
    к {"text": text, "uncompressed": True} на ЛЮБОЙ сбой (недоступность, не-200, кривой
    ответ), а не бросать и не выдавать сжатие за успешное без реального 200."""
    import mcp_server

    mcp_server._headroom_checked_until = 0.0
    long_text = "x" * 5000

    class _DownCfg:
        def get(self, key, default=None):
            table = {"models.cloud.headroom.enabled": True,
                    "models.cloud.headroom.url": "http://127.0.0.1:1",  # порт закрыт
                    "sources.mcp.compress_threshold_chars": 4000}
            return table.get(key, default)

    original_cfg = mcp_server._cfg
    mcp_server._cfg = lambda: _DownCfg()
    try:
        result = mcp_server._maybe_compress(long_text)
    finally:
        mcp_server._cfg = original_cfg
        mcp_server._headroom_checked_until = 0.0
    check("Headroom недоступен: fallback uncompressed=True, текст не потерян",
          result == {"text": long_text, "uncompressed": True}, result)

    class _ShortCfg:
        def get(self, key, default=None):
            return {"sources.mcp.compress_threshold_chars": 4000}.get(key, default)

    mcp_server._cfg = lambda: _ShortCfg()
    try:
        short_result = mcp_server._maybe_compress("короткий текст")
    finally:
        mcp_server._cfg = original_cfg
    check("Headroom: текст короче порога — сжатие не пытается вызываться",
          short_result == {"text": "короткий текст", "uncompressed": True}, short_result)


def test_knowledge_sources(tmp: Path) -> None:
    """Единые знания ИИ-сервисов (§6, 2026-10-09): роли по дереву с отсечками, `~`, scrub,
    фильтр приватности claude-mem, чистка исчезнувших, поиск роли. Проверки — в
    selftest_knowledge.py (вынесены, чтобы не раздувать этот файл)."""
    import selftest_knowledge
    selftest_knowledge.run(tmp, check)
    selftest_knowledge.graph_links(check)


def test_glm_mode(tmp: Path) -> None:
    """Режим «всё на GLM 5.x» (§17.6, 2026-10-09): ростер, лимиты режима, тумблер и отметка
    задачи, очередь мимо memory-guard, предполётная проверка, ревью в режиме, платный контур,
    шлюз, валидатор. Проверки — в selftest_glm.py (вынесены, чтобы не раздувать этот файл)."""
    import selftest_glm
    selftest_glm.run(tmp, check)


def main() -> int:
    print("AI Council — самопроверка\n")
    with tempfile.TemporaryDirectory(prefix="council-selftest-") as raw:
        tmp = Path(raw)
        # Машинный модельный лок — во временной папке: selftest не ждёт живой консилиум с L-моделью (OPS-29).
        import ollama as _ollama
        _ollama.MACHINE_MODEL_LOCK = str(tmp / "machine-large-model.lock")
        print("1. очередь: атомарность захвата (6 конкурентных процессов)")
        test_claim_atomicity(tmp)
        print("\n2. модельный лок (инвариант 24 GB)")
        test_model_lock(tmp)
        test_local_inference_slot(tmp)
        test_local_lock_holder(tmp)
        test_machine_model_lock(tmp)
        test_cloud_lane(tmp)
        print("\n3. возврат зависших прогонов")
        test_reap(tmp)
        print("\n4. идемпотентность")
        test_idempotency(tmp)
        test_escalate_rules()
        print("\n5. валидатор конфига")
        test_config_guards(tmp)
        print("\n6. бюджет облачного яруса (§4а)")
        test_cloud_budget(tmp)
        print("\n7. планировщик (§8)")
        test_planner(tmp)
        print("\n8. знания: каталог и пагинация (v2-P1)")
        test_knowledge(tmp)
        print("\n9. обучение (§9)")
        test_learning(tmp)
        print("\n10. главная форма: @-упоминания и черновик (v2-Ф1/P2)")
        test_home_form(tmp)
        print("\n11. retrieval: устойчивость _linked_ids к мусору в БД (review-p2 #3)")
        test_linked_ids_robustness()
        print("\n12. граф: парсер Prisma-схемы (v2-P3, §3а)")
        test_prisma_parser()
        print("\n13. граф: фильтр связей сохраняет связность (v2-P3, §3б)")
        test_graph_relation_filter()
        print("\n14. граф: LOD по сообществам — инвариант суммы весов (v2-P3, §3в)")
        test_graph_lod_communities()
        print("\n15. граф: гард на пустой межобщинный срез после фильтра (ревью P3, №1)")
        test_graph_communities_empty_filter_guard()
        print("\n16. сессия владельца: жизненный цикл и свёртка закрытия (v2-P4/Ф2)")
        test_session_lifecycle(tmp)
        print("\n17. MCP-сервер: регистрация 4 новых инструментов (v2-P4/Ф2)")
        test_mcp_server_registers_p4_tools()
        print("\n18. Headroom: фолбэк сжатия при недоступности/коротком тексте (v2-P4/Ф2)")
        test_headroom_compress_fallback()
        print("\n19. сессия: гонка двух параллельных open_session (ревью P4, №1)")
        test_open_session_race(tmp)
        print("\n20. дрейф рубрики: дедупликация переформулировок (§9, механизм 4)")
        test_rubric_dedup(tmp)
        test_model_reliability(tmp)
        test_role_board(tmp)
        test_foreign_script()
        test_child_env()
        import selftest_drift_clean          # дрейф M7: маски не пути, команда проверки TS через turbo (§17.9)
        selftest_drift_clean.run(tmp, check)
        import selftest_drift_cloud          # дрейф M10: облачный кластеризатор раз в 12 ч, отказ → локальная модель
        selftest_drift_cloud.run(tmp, check)
        print("\n21. адверсариальная спираль: сходимость по правилу (R5, §5а)")
        test_adversarial_spiral(tmp)
        test_drift_part2(tmp)
        import selftest_drift_infra          # дрейф M4 и M5: сбой инфраструктуры, молчащий арбитр (§17.8)
        selftest_drift_infra.run(tmp, check)
        print("\n22. ревью-оркестрация: политика вердикта, канал Status, очередь (§17)")
        test_review(tmp)
        import selftest_drift_owner          # дрейф M8 и M9: вопрос владельцу, «возможно, уже закрыто» (§17.10)
        selftest_drift_owner.run(tmp, check)
        print("\n23. memory-guard: L-модель не грузится в своп, прогон откладывается")
        test_memory_guard(tmp)
        print("\n24. очередь: пауза/продолжение с того же места, голодание, рестарт")
        test_queue_control(tmp)
        print("\n25. привязки модель/промпт: точечная правка конфига, промпты")
        test_bindings(tmp)
        print("\n26. облачная эскалация: ожидание памяти > 2 ч → облако, повтор по ответу API")
        test_cloud_escalation(tmp)
        print("\n27. единые знания ИИ-сервисов: роли, память, claude-mem, scrub, чистка (§6)")
        test_knowledge_sources(tmp)
        print("\n28. режим «всё на GLM 5.x»: роли, лимиты, тумблер, очередь, ревью (§17.6)")
        test_glm_mode(tmp)
        print("\n29. ревью PR на GLM: потолок попыток, деление диффа, квота и сбои подряд (§17.7)")
        import selftest_pr_review
        selftest_pr_review.run(tmp, check)
        import selftest_tboards              # источник карточек t-boards по запросу (OPS-26)
        selftest_tboards.run(tmp, check)
        import selftest_cards_stats          # сводка карточек для очереди владельца (OPS-38)
        selftest_cards_stats.run(tmp, check)

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} проверок пройдено")
    if failed:
        print("провалено:")
        for name in failed:
            print(f"  • {name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
