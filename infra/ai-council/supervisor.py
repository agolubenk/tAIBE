#!/usr/bin/env python3
"""AI Council — супервизор процессного дерева и CLI подсистемы. Только stdlib.

Канон: docs/specs/ai-council.md §3, §12.

    python3 infra/ai-council/supervisor.py {start|stop|restart|status|doctor}
    python3 infra/ai-council/supervisor.py run  --card <id|next|all> [--profile fast|deep]
    python3 infra/ai-council/supervisor.py plan [--date … --from … --to …]
    python3 infra/ai-council/supervisor.py verdict --run <id> --accept|--reject|--edit

Поднимается из infra/scripts/dev-ai/ai-tooling-pipeline.sh (npm run ai-pipeline:start).

Сервисы объявлены в config.toml `[supervisor] services`. Сервис, модуль которого ещё не
написан, помечается `не реализован` и НЕ перезапускается в цикле — иначе супервизор
превращается в crash-loop генератор логов на каждой фазе внедрения.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as config_mod                      # noqa: E402
import learning as learning_mod                  # noqa: E402
import ollama as ollama_mod                      # noqa: E402
from store import REPO_ROOT, Store, git_sha      # noqa: E402
from config import LAYER_ROOT                     # noqa: E402
from host_root import layer_version              # noqa: E402

STATE_DIR = REPO_ROOT / ".claude/council"
SUPERVISOR_PID = STATE_DIR / "supervisor.pid"

# service -> модуль, который его реализует. Появление файла = сервис становится живым.
SERVICE_MODULES = {
    "gateway": "gateway.py",
    "notion-sync": "notion_sync.py",
    "context": "context_service.py",
    "council": "council_worker.py",
    "planner": "planner_service.py",
    "learning": "learning.py",
}

# Аргументы демонского режима. Планировщик без них строит план и выходит — супервизор
# считал такой выход падением и вечно показывал «остановлен» у штатно отработавшего
# сервиса. Остальные модули демонизируются сами и аргументов не требуют.
SERVICE_ARGS = {
    "planner": ["--watch"],
    "learning": ["--watch"],
}

# Облачные полосы воркера (`council_worker.py --lane cloud`): параллельные прогоны, пока действует
# режим GLM 5.x, — локальный инференс они не запускают. Сколько поднимать — `supervisor.services`.
for _lane in range(1, 5):
    SERVICE_MODULES[f"council-cloud-{_lane}"] = "council_worker.py"
    SERVICE_ARGS[f"council-cloud-{_lane}"] = ["--lane", "cloud"]


# ── процессные примитивы ────────────────────────────────────────────────────
def pid_file(name: str) -> Path:
    return STATE_DIR / f"{name}.pid"


def log_file(name: str) -> Path:
    return STATE_DIR / f"{name}.log"


def read_pid(path: Path) -> int | None:
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)          # сигнал 0 — проверка существования, процесс не трогает
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True              # процесс есть, просто чужой — это «жив»
    except OSError:
        return False


def implemented(service: str) -> bool:
    return (HERE / SERVICE_MODULES.get(service, "")).is_file()


def child_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Окружение детей супервизора. macOS: `MallocStackLogging*` из окружения запуска (терминал, IDE) наследуют все
    потомки, и каждый процесс Python печатает в council.log «MallocStackLogging: can't turn off malloc stack
    logging because it was not enabled» — до 20.10 это 5,3 тыс. строк из 28,7 тыс. Диагностика malloc консилиуму
    не нужна."""
    env = dict(os.environ if base is None else base)
    for key in [k for k in env if k.startswith("MallocStackLogging")]:
        env.pop(key)
    return env


def spawn(service: str) -> subprocess.Popen | None:
    module = SERVICE_MODULES.get(service)
    if not module or not implemented(service):
        return None
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    handle = log_file(service).open("ab")
    proc = subprocess.Popen(
        [sys.executable, str(HERE / module)] + SERVICE_ARGS.get(service, []),
        stdout=handle, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        cwd=str(REPO_ROOT), start_new_session=True, env=child_env(),
    )
    pid_file(service).write_text(str(proc.pid))
    return proc


def terminate(name: str, timeout: float = 8.0) -> bool:
    pid = read_pid(pid_file(name))
    if not alive(pid):
        pid_file(name).unlink(missing_ok=True)
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pid_file(name).unlink(missing_ok=True)
        return False
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not alive(pid):
            break
        time.sleep(0.2)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    pid_file(name).unlink(missing_ok=True)
    return True


# ── команды ─────────────────────────────────────────────────────────────────
def cmd_start(cfg, args) -> int:
    # Сравнение с os.getpid() обязательно: дочерний `start --foreground` иначе увидит
    # в PID-файле собственный pid и решит, что супервизор уже поднят (гонка с родителем).
    existing = read_pid(SUPERVISOR_PID)
    if alive(existing) and existing != os.getpid():
        print(f"→ супервизор уже запущен (pid {existing})")
        return 0

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    Store().close()                      # применяет schema.sql, если БД новая

    if args.foreground:
        return _supervise(cfg)

    handle = log_file("supervisor").open("ab")
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "supervisor.py"), "start", "--foreground"],
        stdout=handle, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        cwd=str(REPO_ROOT), start_new_session=True, env=child_env(),
    )
    # PID-файл пишет сам дочерний процесс (в _supervise) — родитель только ждёт появления,
    # иначе владелец файла неоднозначен и стоп-логика гонится с рестартом.
    deadline = time.time() + 5.0
    while time.time() < deadline:
        if read_pid(SUPERVISOR_PID) == proc.pid:
            break
        if proc.poll() is not None:
            print(f"Ошибка: супервизор упал на старте, см. {log_file('supervisor')}",
                  file=sys.stderr)
            return 1
        time.sleep(0.1)
    else:
        print(f"Ошибка: супервизор не отметился за 5s, см. {log_file('supervisor')}",
              file=sys.stderr)
        return 1

    print(f"→ AI Council: супервизор pid {proc.pid}, лог {log_file('supervisor')}")
    _print_service_table(cfg)
    return 0


def _supervise(cfg) -> int:
    """Цикл супервизора. Работает в foreground; демонизирует его вызывающий."""
    SUPERVISOR_PID.write_text(str(os.getpid()))
    services = [s for s in cfg.get("supervisor.services", []) if implemented(s)]
    backoff = cfg.get("supervisor.restart_backoff_seconds", 5)
    max_restarts = cfg.get("supervisor.max_restarts_per_hour", 10)
    stale_ttl = cfg.get("supervisor.stale_run_ttl_seconds", 900)
    restarts: dict[str, list[float]] = {s: [] for s in services}
    # Живость СВОИХ детей определяется только через Popen.poll(), не через os.kill(pid, 0):
    # убитый ребёнок остаётся зомби, пока родитель его не отжал, а на зомби kill(pid,0)
    # успешно проходит — супервизор считал бы мёртвый сервис живым и никогда не поднял.
    # poll() и проверяет, и отжимает. PID-файлы остаются для внешних status/stop.
    procs: dict[str, subprocess.Popen] = {}
    services_disabled: set[str] = set()      # выбывшие по лимиту перезапусков
    stopping = False

    def _stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    for service in services:
        proc = spawn(service)
        if proc:
            procs[service] = proc
            _log(f"старт {service} (pid {proc.pid})")

    store = Store()
    last_reap = 0.0
    try:
        while not stopping:
            for service in services:
                if service in services_disabled:
                    continue
                proc = procs.get(service)
                if proc is not None and proc.poll() is None:
                    continue
                if proc is not None:
                    _log(f"{service}: процесс {proc.pid} завершился, код {proc.returncode}")
                window = [t for t in restarts[service] if time.time() - t < 3600]
                restarts[service] = window
                if len(window) >= max_restarts:
                    _log(f"{service}: лимит перезапусков ({max_restarts}/ч) — не поднимаю")
                    procs.pop(service, None)
                    services_disabled.add(service)
                    continue
                time.sleep(backoff)
                restarts[service].append(time.time())
                new_proc = spawn(service)
                if new_proc:
                    procs[service] = new_proc
                    _log(f"{service}: перезапуск pid {new_proc.pid} "
                         f"({len(restarts[service])}/{max_restarts} за час)")

            # Прогоны, чей воркер умер молча, вернуть в очередь — иначе очередь деградирует.
            if time.time() - last_reap > 60:
                reaped = store.reap_stale(stale_ttl)
                if reaped:
                    _log(f"reap: {reaped} зависших прогонов возвращено в очередь")
                store.prune_events()
                last_reap = time.time()
            time.sleep(2.0)
    finally:
        store.close()
        for service in reversed(services):
            terminate(service)
            _log(f"стоп {service}")
        SUPERVISOR_PID.unlink(missing_ok=True)
        _log("супервизор остановлен")
    return 0


def _log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def cmd_stop(cfg, _args) -> int:
    stopped = terminate("supervisor")
    for service in cfg.get("supervisor.services", []):
        terminate(service)
    print("→ AI Council остановлен" if stopped else "→ AI Council не был запущен")
    print("  Ollama не трогаем — общий демон, нужен и продуктовому npm run dev:ai")
    return 0


def cmd_restart(cfg, args) -> int:
    cmd_stop(cfg, args)
    time.sleep(1.0)
    return cmd_start(cfg, args)


def _print_service_table(cfg) -> None:
    for service in cfg.get("supervisor.services", []):
        if not implemented(service):
            state = "— не реализован (фаза не начата)"
        elif alive(read_pid(pid_file(service))):
            state = f"работает, pid {read_pid(pid_file(service))}"
        else:
            state = "остановлен"
        print(f"    {service:14} {state}")


def cmd_status(cfg, _args) -> int:
    sup = read_pid(SUPERVISOR_PID)
    print("=== AI Council ===")
    print(f"супервизор: {'работает, pid ' + str(sup) if alive(sup) else 'остановлен'}")
    print(f"код слоя:   {layer_version()} · {LAYER_ROOT}")
    _print_service_table(cfg)

    problems = getattr(cfg, "problems", [])
    print(f"\nконфиг:     {cfg.path.name} · hash {cfg.config_hash()} · "
          f"профиль {cfg.get('models.profile')}"
          + (f" · ⚠ {len(problems)} проблем" if problems else ""))
    print(f"Notion:     {'подключён' if cfg.notion_enabled() else 'ОФЛАЙН (нет ключа)'}")

    client = ollama_mod.build(cfg)
    if client.alive():
        loaded = [m.get("name") for m in client.loaded_models()]
        print(f"Ollama:     жива · резидентно: {', '.join(loaded) if loaded else 'ничего'}")
    else:
        print(f"Ollama:     НЕ отвечает ({client.base_url})")

    try:
        with Store() as store:
            depth = store.queue_depth()
            cards = store.q1("SELECT COUNT(*) n FROM cards")["n"]
            lock = store.current_model_lock()
            print(f"БД:         {cards} карточек · очередь: "
                  f"{', '.join(f'{k}={v}' for k, v in depth.items()) if depth else 'пусто'}")
            print(f"модельный лок: {lock['model'] + ' (' + lock['holder'] + ')' if lock else 'свободен'}")
    except Exception as exc:                                  # noqa: BLE001
        print(f"БД:         недоступна — {exc}")

    if REPO_ROOT != LAYER_ROOT:
        print(f"хост git:   {git_sha() or 'неизвестен'} · {REPO_ROOT}")
    if problems:
        print("\n⚠ проблемы конфига:")
        for m in problems:
            print(f"  • {m}")
    return 0


def cmd_doctor(cfg, _args) -> int:
    """Предполётная проверка: что мешает подсистеме работать в полную силу."""
    checks: list[tuple[str, bool, str]] = []

    checks.append(("Python ≥ 3.11 (tomllib)", sys.version_info >= (3, 11), sys.version.split()[0]))

    client = ollama_mod.build(cfg)
    checks.append(("Ollama отвечает", client.alive(), client.base_url))
    if client.alive():
        installed = set(client.installed_models())
        # Облачные модели проверяются наличием ключа и ростера, а не `ollama list` —
        # иначе профили hybrid/cloud вечно числятся «неукомплектованными».
        cloud_models = set()
        for node in (cfg.get("models.cloud.providers", {}) or {}).values():
            cloud_models |= set(node.get("models") or [])
        for profile in ("fast", "deep", "hybrid", "cloud"):
            try:
                roster = cfg.roles(profile)
            except config_mod.ConfigError:
                continue                       # профиль не объявлен — это не поломка
            missing = [m for m in roster.values()
                       if m not in installed and m not in cloud_models]
            used_cloud = sorted({m for m in roster.values() if m in cloud_models})
            detail = "все на месте" if not missing else f"нет: {', '.join(missing)}"
            if used_cloud:
                detail += f" · облако: {', '.join(used_cloud)}"
                if not cfg.cloud_enabled():
                    detail += " (облако ВЫКЛЮЧЕНО — AI_COUNCIL_CLOUD=1)"
            checks.append((f"модели профиля {profile}", not missing, detail))

    key = cfg.notion_key()
    checks.append(("Notion-ключ", bool(key), "найден" if key else
                   f"нет — {cfg.get('sources.notion.key_file')} или env NOTION_API_KEY"))
    if key:
        keyfile = cfg.path_of("sources.notion.key_file")
        if keyfile.is_file():
            mode = oct(keyfile.stat().st_mode & 0o777)
            checks.append(("права на ключ", mode == "0o600", f"{mode} (нужно 0o600)"))

    rag = cfg.path_of("sources.rag.db")
    checks.append(("DAMS RAG-индекс", rag.is_file(),
                   str(rag.relative_to(REPO_ROOT)) if rag.is_file() else
                   "нет — python3 .claude/scripts/index_rebuild.py"))

    graph = cfg.path_of("sources.graph.path")
    checks.append(("graphify-граф", graph.is_file(),
                   str(graph) if graph.is_file() else
                   "нет graph.json — python3 infra/ai-council/graph_build.py"
                   " (или UI консилиума → «Собрать граф проекта»: AST + слой Prisma)"))

    done = cfg.path_of("sources.done_md.path")
    done_ok = done.is_dir() and any(done.glob("*.md")) or done.is_file()
    checks.append(("закрытое (DONE)", done_ok, str(done.relative_to(REPO_ROOT))))

    plan = cfg.path_of("outputs.plan_file")
    checks.append(("файл плана существует", plan.is_file(), str(plan.relative_to(REPO_ROOT))))

    checks.append(("конфиг валиден", not getattr(cfg, "problems", []),
                   "ок" if not getattr(cfg, "problems", []) else
                   f"{len(cfg.problems)} проблем — supervisor.py status"))

    # Облачный ярус (§4а): выключенное облако — валидное состояние, а не проблема.
    # Проверяем другое: если включено, есть ли чем платить и не пробит ли потолок.
    if cfg.cloud_enabled():
        import cloud as cloud_mod
        with Store() as cloud_store:
            cloud_client = cloud_mod.build(cfg, cloud_store)
            judge = cfg.cloud_role("judge")
            ok, why = cloud_client.available(judge)
            checks.append(("облачный ярус", ok, f"{judge}: {'готов' if ok else why}"))
            # На подписке главный лимит — окно, а не деньги: показываем именно его.
            window, budget = cloud_client.spent_in_window(), cloud_client.budget
            checks.append(("окно плана", window["calls"] < budget.max_calls_per_window,
                           f"{window['calls']}/{budget.max_calls_per_window} вызовов за "
                           f"{budget.window_hours} ч"))
            day = cloud_client.spent_today()
            checks.append(("суточный лимит облака", day["calls"] < budget.max_calls_per_day,
                           f"{day['calls']}/{budget.max_calls_per_day} вызовов"))
    else:
        checks.append(("облачный ярус", True,
                       "выключен (models.cloud.enabled=false) — всё локально"))

    for service, module in SERVICE_MODULES.items():
        checks.append((f"сервис {service}", implemented(service),
                       module if implemented(service) else "фаза не начата"))

    width = max(len(name) for name, _, _ in checks)
    failed = 0
    for name, ok, detail in checks:
        if not ok:
            failed += 1
        print(f"  {'✓' if ok else '✗'} {name.ljust(width)}  {detail}")
    print(f"\n{len(checks) - failed}/{len(checks)} проверок пройдено")
    return 0


def cmd_run(cfg, args) -> int:
    """Поставить карточки в очередь. Исполняет их council-воркер (фаза P2)."""
    profile = args.profile or ("fast" if cfg.get("models.profile") == "adaptive"
                               else cfg.get("models.profile"))
    # Ставить в очередь облачный профиль при выключенном облаке — значит наполнить
    # очередь прогонами, каждый из которых воздержится, не сделав ни одного вызова.
    if profile in ("hybrid", "cloud") and not cfg.cloud_enabled():
        print(f"Профиль `{profile}` работает на облачных моделях, а облако выключено.\n"
              f"Включить на прогон: AI_COUNCIL_CLOUD=1 npm run ai-council:run -- "
              f"--card {args.card} --profile {profile}", file=sys.stderr)
        return 1
    # Режим «всё на GLM 5.x» (§17.6): задача с отметкой без облака не подменяется локальной —
    # тот же гвард, что у облачных профилей, только раньше, на постановке.
    cloud_mode = "glm5" if getattr(args, "glm", False) else ""
    if cloud_mode and not cfg.cloud_enabled():
        print("Режим GLM 5.x работает только в облаке, а оно выключено: models.cloud.enabled=true "
              "в infra/ai-council/config.toml, затем npm run ai-pipeline:restart", file=sys.stderr)
        return 1

    # Ловушка, которую иначе видно только по итогу: `run` лишь СТАВИТ в очередь, а
    # исполняет её демон-воркер под супервизором — со своим окружением. Переменная
    # AI_COUNCIL_CLOUD=1, заданная этой команде, до него не доходит, и облачный профиль
    # молча превращается в очередь гарантированных воздержаний. Флаг в конфиге доходит
    # до всех процессов, поэтому для ночного прогона нужен именно он.
    if (profile in ("hybrid", "cloud") or cloud_mode) and not cfg.get("models.cloud.enabled", False) \
            and alive(read_pid(pid_file("council"))):
        print(f"⚠ Облако включено только переменной окружения этой команды, но карточки "
              f"исполняет демон-воркер (council, pid {read_pid(pid_file('council'))}) — "
              f"он её не видит и " + ("завершит задачи режима GLM 5.x с причиной «нет облака»"
                                      if cloud_mode else "воздержится на каждой карточке") + ".\n"
              f"  Для прогона профилем `{profile}`: поставить "
              f"`enabled = true` в [models.cloud] файла infra/ai-council/config.toml, "
              f"затем `npm run ai-pipeline:restart`.\n"
              f"  Либо разобрать очередь вручную, в этом же окружении: "
              f"AI_COUNCIL_CLOUD=1 python3 infra/ai-council/council_worker.py --once",
              file=sys.stderr)
    with Store() as store:
        if args.card == "all":
            cards = store.open_cards()
        elif args.card == "next":
            cards = store.open_cards()[:1]
        else:
            card = store.get_card(args.card)
            cards = [card] if card else []
            if not card:
                print(f"Карточка {args.card} не найдена в снапшоте. "
                      "Сначала синхронизация: npm run ai-council:sync", file=sys.stderr)
                return 1
        if not cards:
            print("Снапшот карточек пуст — сначала npm run ai-council:sync")
            return 1

        queued = 0
        for card in cards:
            track = "half_baked" if card.get("half_baked") else "elaborate"
            run_id = store.enqueue(
                card["card_id"], track=track, profile=profile,
                priority=2 if card["db"] == "bugs" else 1,
                config_hash=cfg.config_hash(), git_sha=git_sha(),
                card_hash=card.get("content_hash") or "", cloud_mode=cloud_mode,
            )
            if run_id:
                queued += 1
        print(f"→ в очередь поставлено {queued} из {len(cards)} (остальные уже в работе)"
              + (" · все роли на GLM 5.x" if cloud_mode else ""))
        if not implemented("council"):
            print("  ⚠ council-воркер ещё не реализован (фаза P2) — очередь будет ждать")
    return 0


def cmd_plan(cfg, args) -> int:
    if not implemented("planner"):
        print("Планировщик ещё не реализован (фаза P4 в docs/specs/ai-council.md §14).",
              file=sys.stderr)
        return 1
    # Аргументы окна пробрасываются как есть: раньше подкоманда их принимала и молча
    # теряла, то есть `plan --from 11:00` строил план по конфигу и врал о том, что учёл.
    cmd = [sys.executable, str(HERE / SERVICE_MODULES["planner"]), "--once"]
    for flag, value in (("--date", getattr(args, "date", "")),
                        ("--from", getattr(args, "time_from", "")),
                        ("--to", getattr(args, "time_to", ""))):
        if value:
            cmd += [flag, str(value)]
    return subprocess.call(cmd, cwd=str(REPO_ROOT))


def cmd_verdict(cfg, args) -> int:
    decision = "accept" if args.accept else "reject" if args.reject else "edit"
    with Store() as store:
        if not store.q1("SELECT id FROM runs WHERE id = ?", (args.run,)):
            print(f"Прогон {args.run} не найден", file=sys.stderr)
            return 1
        store.x(
            "INSERT INTO verdicts (run_id, decision, comment, created_at) VALUES (?,?,?,?)",
            (args.run, decision, args.comment or "", int(time.time())),
        )
        store.event("verdict", args.run, decision)
        # §9: вердикт немедленно уходит в веса надёжности моделей — тот же хук, что в UI.
        learned = learning_mod.apply_run(store, args.run)
    print(f"→ вердикт `{decision}` записан для {args.run}")
    counted = learned["verdicts"]["applied"] + learned["hallucinations"]["applied"]
    if counted:
        print(f"  обучение: учтено сигналов {counted} "
              f"(`npm run ai-council:learning-stats` — таблица надёжности)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="ai-council", description="AI Council supervisor")
    sub = parser.add_subparsers(dest="cmd")

    p_start = sub.add_parser("start")
    p_start.add_argument("--foreground", action="store_true")
    sub.add_parser("stop")
    p_restart = sub.add_parser("restart")
    p_restart.add_argument("--foreground", action="store_true")
    sub.add_parser("status")
    sub.add_parser("doctor")

    p_run = sub.add_parser("run")
    p_run.add_argument("--card", default="next")
    p_run.add_argument("--profile", choices=["fast", "deep", "hybrid", "cloud"])
    p_run.add_argument("--glm", action="store_true",
                       help="все роли на GLM 5.x (Coding Plan), локально только embed (§17.6)")

    p_plan = sub.add_parser("plan")
    p_plan.add_argument("--date")
    p_plan.add_argument("--from", dest="time_from")
    p_plan.add_argument("--to", dest="time_to")

    p_verdict = sub.add_parser("verdict")
    p_verdict.add_argument("--run", required=True)
    p_verdict.add_argument("--accept", action="store_true")
    p_verdict.add_argument("--reject", action="store_true")
    p_verdict.add_argument("--edit", action="store_true")
    p_verdict.add_argument("--comment", default="")

    args = parser.parse_args()
    if not args.cmd:
        parser.print_help()
        return 1

    try:
        cfg = config_mod.load(strict=False)
    except config_mod.ConfigError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 1

    # start/restart не поднимаем на заведомо сломанном конфиге — тихо работающая
    # подсистема с невалидными правилами хуже, чем невставшая.
    if args.cmd in ("start", "restart") and getattr(cfg, "problems", []):
        print("❌ конфиг непригоден — исправьте и повторите:", file=sys.stderr)
        for problem in cfg.problems:
            print(f"  • {problem}", file=sys.stderr)
        return 1

    handlers = {
        "start": cmd_start, "stop": cmd_stop, "restart": cmd_restart,
        "status": cmd_status, "doctor": cmd_doctor, "run": cmd_run,
        "plan": cmd_plan, "verdict": cmd_verdict,
    }
    return handlers[args.cmd](cfg, args)


if __name__ == "__main__":
    sys.exit(main())
