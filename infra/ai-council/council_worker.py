#!/usr/bin/env python3
"""AI Council — воркер очереди. Только stdlib.

Канон: docs/specs/ai-council.md §3, §5.

    python3 infra/ai-council/council_worker.py              # сервис (под супервизором)
    python3 infra/ai-council/council_worker.py --once       # разобрать очередь и выйти
    python3 infra/ai-council/council_worker.py --card <id> [--profile fast|deep]

Берёт прогоны из очереди транзакционно (store.claim_run), исполняет протокол консилиума,
пишет результат. Heartbeat каждый цикл — иначе упавший воркер оставил бы прогон в running
навсегда (супервизор вернёт его в очередь по reap_stale).

Эскалация в тяжёлый профиль (§4): решение принимается ПОСЛЕ лёгкого прохода, по его
результату — воздержание, низкая уверенность, критичность карточки. Прогон в deep ставится
новой записью в очередь, а не рекурсией: так он виден в очереди, переживает перезапуск
и не удваивает время удержания модельного лока.
"""
from __future__ import annotations

import argparse
import json
import signal
import threading
from contextlib import contextmanager
import sys
import time
from typing import NamedTuple
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import cloud as cloud_mod                                # noqa: E402
import config as config_mod                              # noqa: E402
import council_infra                                     # noqa: E402
import glm_mode                                          # noqa: E402
import ollama as ollama_mod                              # noqa: E402
import queue_control                                     # noqa: E402
from cloud_escalation import CloudUnavailable, Escalation  # noqa: E402
import retrieval as retrieval_mod                        # noqa: E402
from council import Council                              # noqa: E402
import council_closed                                    # noqa: E402
from review_cli import process_run as process_review     # noqa: E402
from review_engine import ReviewEngine                   # noqa: E402
from store import Store, git_sha                         # noqa: E402

_stopping = False

# Профили, где облачные модели — участники консилиума, а не последняя инстанция.
# Без включённого облака такой прогон бессмысленен (см. main).
# deep — с 2026-10-23: локальных L-моделей нет, предложения и арбитр идут в облако.
CLOUD_PROFILES = ("deep", "hybrid", "cloud")


def _handle_stop(_signum, _frame):
    global _stopping
    _stopping = True


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def should_escalate(cfg, card: dict, outcome) -> bool:
    rules = cfg.get("models.escalate_to_deep_when", {}) or {}
    if card.get("half_baked") and rules.get("half_baked"):
        return True
    if rules.get("fast_abstained") and outcome.status == "abstained":
        return True
    threshold = rules.get("confidence_lt")
    if threshold is not None and outcome.status == "done" and outcome.confidence < threshold:
        return True
    severities = rules.get("severity_in") or []
    if card.get("severity") in severities:
        return True
    # Приоритет — у «Задач» нет severity, P0 там выражен только приоритетом (d-council-run, 17.10).
    priorities = rules.get("priority_in") or []
    if card.get("priority") in priorities:
        return True
    modules_gt = rules.get("modules_gt")
    if modules_gt is not None:
        try:
            if len(json.loads(card.get("modules") or "[]")) > int(modules_gt):
                return True
        except ValueError:
            pass
    return False


def _idle(seconds: int) -> None:
    for _ in range(seconds):
        if _stopping:
            return
        time.sleep(1)


def _release_for_memory(store: Store, run_id: str, why: str, not_before: int | None = None) -> None:
    """Вернуть прогон на его место в очереди без сожжённой попытки; `not_before` — не раньше (квота подписки).
    Не воздержание — карточка ни при чём, и записывать ей «консилиум не справился»
    было бы ложью в статистику обучения. Профиль блокирует вызывающий (MemoryBlocks)."""
    store.x("UPDATE runs SET status='queued', claimed_by=NULL, claimed_at=NULL, started_at=NULL, "
            "attempts=MAX(attempts-1, 0), not_before=?, error=? WHERE id=?", (not_before, why[:500], run_id))


def _defer_infra(store: Store, run: dict, why: str) -> None:
    """Дрейф M4: сбой инфраструктуры локальных моделей — прогон в очередь с растущей паузой (15, затем 30 мин), с новым
    дедлайном; после двух откладываний — воздержание с явной причиной, а не «консилиум не справился с карточкой»."""
    row = store.q1("SELECT infra_deferrals FROM runs WHERE id = ?", (run["id"],)) or {}
    done = int(row.get("infra_deferrals") or 0)
    if done >= council_infra.MAX_DEFERRALS:
        reason = f"{council_infra.ABSTAIN_PREFIX}: {why}"
        store.finish_run(run["id"], "abstained", reason, payload={"open_questions": [], "reason": reason},
                         confidence=0.0, readiness=0.0)
        log(f"    ⊘ {reason} — отложен уже {done} раза, дальше не откладываю")
        return
    pause = council_infra.defer_pause(done)
    store.defer_run(run["id"], int(time.time()) + pause, council_infra.DEFER_PREFIX + why)
    log(f"    ⏸ {why} — прогон отложен на {pause // 60} мин ({done + 1}/{council_infra.MAX_DEFERRALS})")


def _glm_gate(cfg, store: Store, council: Council, run: dict) -> bool:
    """Режим «всё на GLM 5.x» (§17.6): можно ли начинать прогон. False — прогон уже
    обработан здесь: отложен до освобождения окна (воздержание на пустых облачных раундах
    было бы ложью в статистику обучения) либо завершён с причиной, если ожиданием это не
    лечится (облако выключено, нет ключа) — локально задача, отмеченная режимом, молча
    не подменяется."""
    ok, why, retry_at = glm_mode.preflight(council.cloud, cfg, run["id"])
    if ok:
        return True
    if retry_at:
        store.x("UPDATE runs SET status='queued', claimed_by=NULL, claimed_at=NULL, "
                "started_at=NULL, attempts=MAX(attempts-1, 0), not_before=?, error=? WHERE id=?",
                (int(retry_at), (glm_mode.DEFER_PREFIX + why)[:500], run["id"]))
        log(f"    ⏸ GLM 5.x: {why} — повтор в "
            f"{time.strftime('%H:%M', time.localtime(retry_at))}")
    else:
        store.finish_run(run["id"], "failed", error=why)
        log(f"    ✗ GLM 5.x: {why}")
    return False


def _glm_tick(cfg, store: Store, cloud_client, was: bool | None) -> tuple[bool, bool]:
    """Тумблер «всё на GLM 5.x» в шапке (§17.6) — на каждом цикле, рестарт не нужен:
    (включён, действует). Лимиты общего клиента — по нему же: ревью и эскалация берут бюджет
    из того же клиента. Облако выключено — тумблер не действует. Режим не действует (выключили,
    облако выключено, в том числе к старту воркера) — задачи, отложенные режимом по тумблеру,
    обратно на свои места: без режима они идут локально."""
    requested = glm_mode.is_on(store)
    on = glm_mode.effective(store, cfg)
    if requested != was:
        if on:
            log("☁ режим «всё на GLM 5.x» включён — новые прогоны идут в Coding Plan")
        else:
            if requested:
                log("⚠ GLM 5.x включён в шапке, но облако выключено — режим не действует")
            n = glm_mode.release_deferred(store)
            if was or n:
                log("режим GLM 5.x " + ("не действует" if requested else "выключен")
                    + (f" — {n} отложенных вернул в очередь" if n else ""))
    glm_mode.apply_budget(cloud_client, cfg, on)
    return requested, on


def _pipeline_on(name: str) -> bool:
    """The product's switch (tAI-Boards → workspace settings → «Pipeline & evolution»): off stops the review of cards
    on review, on top of the council's own `worker_enabled`. Errors and a host without the layer → on."""
    try:
        sys.path.insert(0, str(HERE.parent.parent / ".claude" / "scripts"))
        import pipeline_settings
        return pipeline_settings.enabled(name)
    except Exception:  # noqa: BLE001 — the worker never stops on settings
        return True


def _claim_review(reviewer, worker_id: str, blocks: queue_control.MemoryBlocks, route: str, glm_live: bool):
    """Следующее ревью по маршруту (plan_routes). Профили, ждущие память, пропускаются всегда, когда ревью может
    пойти локально; без блоков — только если оно наверняка в GLM 5.x (маршрут `glm` или `any` при живом режиме:
    все агенты в облаке, L-моделей нет, §17.6). Ревью с отметкой режима проходит блок и так (ReviewStore.claim).
    Без этого заблокированный профиль захватывался по кругу: memory → release → тот же захват (ревью #156)."""
    on_glm = route == "glm" or (route == "any" and glm_live)
    return reviewer.rs.claim(worker_id, [] if on_glm else blocks.active("review"), route=route)


class Routes(NamedTuple):
    """Что берёт воркер на этом обороте: маршрут захвата ревью и проработок (`any` | `local` | `glm` | "" —
    не брать) и `idle` — брать нечего вовсе (облачная полоса при недоступном GLM)."""
    reviews: str
    runs: str
    idle: bool = False


def plan_routes(glm_on: bool, glm_ok: bool, glm_runs: bool, cloud_lane: bool, lanes: bool,
                cloud_on: bool = True) -> Routes:
    """Маршруты захвата для основного воркера и облачной полосы.

    glm_on — тумблер шапки действует; glm_ok — GLM 5.x доступен сейчас (glm_mode.available_now); glm_runs —
    тумблер действует и на проработки (`runs_on_glm`); lanes — облачная полоса поднята супервизором.

    * Полоса: только пока GLM доступен — отмеченное, а по тумблеру и неотмеченное; иначе ждёт.
    * Основной воркер с полосой: пока GLM доступен — только локальное (облачное у полосы); ревью по тумблеру
      облачные — их не берёт.
    * Основной воркер без полосы: GLM доступен — всё, как раньше; недоступен — только локальное.
    Отмеченное «только для GLM» при недоступном GLM не захватывается никем — вторая очередь до восстановления.
    Облако выключено вовсе (cloud_on = False) — ожиданием не лечится: основной воркер берёт всё, отмеченное
    завершается с причиной (_glm_gate / review_gate), а не висит молча."""
    if cloud_lane:
        if not cloud_on:
            return Routes("", "", idle=True)
        if not glm_ok:
            return Routes("", "", idle=True)
        return Routes("any" if glm_on else "glm", "any" if glm_runs else "glm")
    if not cloud_on or (glm_ok and not lanes):
        return Routes("any", "any")
    if glm_ok:
        return Routes("" if glm_on else "local", "" if glm_runs else "local")
    return Routes("local", "local")


def _ran_on_glm(reviewer, run: dict) -> bool:
    """Ревью шло в режиме GLM 5.x (отметка запуска или снимок плана): L-модели не проверялись."""
    if glm_mode.requested(run.get("request")):
        return True
    snap = (reviewer.rs.run(run["id"]) or {}).get("snapshot") or {}
    return bool(snap.get("glm"))


def _run_review(cfg, reviewer, run: dict, blocks: queue_control.MemoryBlocks,
                escalation: Escalation | None = None) -> None:
    outcome, why = process_review(cfg, reviewer, run, log, escalation)
    key = run.get("profile_id") or ""
    if outcome in ("cloud_wait", "failed"):
        # Повтор уже назначен (Escalation.defer / режим GLM 5.x ждёт окно подписки) или итог с
        # причиной записан без загрузки моделей — блок памяти профиля этим не подтверждён и не снят.
        return
    if outcome == "memory":
        if blocks.block("review", key, why, label=f"ревью «{run.get('profile_name') or key}»"):
            log(f"  ⏸ ревью «{run.get('profile_name')}»: {why} — профиль ждёт память, "
                f"очередь идёт дальше")
    # После облачного прогона (эскалация, режим GLM 5.x) память не проверялась: снимать блок
    # нельзя — clear обнулил бы стаж ожидания остальных ревью профиля, и до облака им пришлось
    # бы ждать ещё 2 ч.
    elif outcome == "ok" and escalation is None and not _ran_on_glm(reviewer, run) \
            and blocks.clear("review", key):
        log(f"  ▶ ревью «{run.get('profile_name')}»: память появилась, профиль снова в работе")


def _process(cfg, store: Store, council: Council, retriever, run: dict,
            blocks: queue_control.MemoryBlocks | None = None,
            escalation: Escalation | None = None, glm_only: bool = False) -> None:
    card = store.get_card(run["card_id"]) if run.get("card_id") else None
    if not card:
        store.finish_run(run["id"], "failed", error=f"карточка {run.get('card_id')} не в снапшоте")
        return

    label = "Ошибка" if card["db"] == "bugs" else "Задача"
    log(f"  ▶ [{run['profile']}/{run['track']}] {label}: {card['title'][:70]}")

    # Потолок облачных вызовов зависит от профиля: в `cloud`/`hybrid` облако ведёт
    # консилиум, а не спасает его. Ставится на каждой карточке, потому что воркер
    # разбирает очередь со смешанными профилями.
    if council.cloud is not None:
        council.cloud.profile = run["profile"]

    # Режим «всё на GLM 5.x» (§17.6): отметка самой задачи — всегда; тумблер шапки — пока
    # облако включено (иначе он не действует, и шапка это показывает). Решение принимается
    # на каждом захвате, поэтому переключение не требует рестарта воркера.
    # glm_only — облачная полоса: GLM пропал между захватом и стартом → прогон откладывается режимом (_glm_gate),
    # а не идёт локально параллельно основному воркеру (локальный инференс — строго по одному).
    glm = glm_mode.requested(run) or glm_only or (glm_mode.effective_for_runs(store, cfg)
                                                  and glm_mode.available_now(cfg, council.cloud)[0])
    # Лимиты клиента — на КАЖДОМ прогоне: клиент общий, и лимиты прошлого прогона (режим
    # задачи) иначе достались бы следующему.
    glm_mode.apply_budget(council.cloud, cfg, glm)

    roles_override, esc_models, waited = None, {}, 0
    if glm:
        # Эскалация памяти режиму не нужна: облачные в нём все роли, а не только L.
        escalation = None
        if not _glm_gate(cfg, store, council, run):
            return
        roles_override = glm_mode.roles_override(cfg, council.roster(run["profile"], card))
        store.x("UPDATE runs SET cloud_mode = ? WHERE id = ?", (glm_mode.CLOUD_MODE, run["id"]))
        log("    ☁ GLM 5.x: " + ", ".join(f"{r} {m}" for r, m in sorted(roles_override.items())))
    if escalation is not None:
        # Облачная эскалация (§17.4): прогон ждал памяти дольше порога. Тот же ростер,
        # L-роли — облачными моделями первого доступного провайдера; S-роли — локально.
        roster = council.roster(run["profile"], card)
        slots = escalation.heavy_slots(roster)
        waited = int(time.time()) - int(run.get("mem_wait_since") or time.time())
        if slots:
            provider, mapping, failures = escalation.choose(run["id"], slots)
            if provider is None:
                escalation.defer("runs", run["id"], failures)
                return
            roles_override = {**roster, **mapping}
            esc_models = {role: {"from": roster[role], "to": model} for role, model in mapping.items()}
            escalation.start(run["id"], provider)
            council.escalation = escalation
            log(f"    ☁ эскалация: ждал памяти {waited // 60} мин → {provider}: " + ", ".join(
                f"{r} {v['from']}→{v['to']}" for r, v in esc_models.items()))
        else:
            escalation = None              # тяжёлых ролей нет — обычный локальный путь

    # Memory-guard до любой работы: если L-модели профиля некуда встать, карточку не
    # начинаем (капсула и S-раунды впустую), а откладываем — см. ollama.memory_snapshot.
    try:
        roster = (roles_override or cfg.roles(run["profile"])) or {}
    except config_mod.ConfigError:
        roster = {}                    # неизвестный профиль — разберётся run_card, не guard
    for role_model in sorted(set(roster.values())):
        if council.is_cloud_model(role_model):
            continue
        fits, why = council.ollama.memory_check(role_model)
        if not fits:
            council.escalation = None
            _release_for_memory(store, run["id"], why)
            if blocks is not None and blocks.block("runs", run["profile"], why,
                                                   label=f"профиль {run['profile']}"):
                log(f"    ⏸ профиль {run['profile']}: {why} — его прогоны ждут память на своих "
                    f"местах, очередь идёт дальше")
            return
    # В режиме GLM L-модели не проверялись (их в ростере нет) — снимать блок памяти профиля
    # нельзя: это обнулило бы стаж ожидания его локальных задач.
    if escalation is None and not glm and blocks is not None \
            and blocks.clear("runs", run["profile"]):
        log(f"    ▶ профиль {run['profile']}: память появилась, снова в работе")

    started = time.time()
    council.glm_mode = glm
    try:
        # Указание владельца к карточке, если оно есть, — уходит в pinned-часть капсулы
        # с явным приоритетом над выводами из кода. Живёт на карточке, поэтому
        # применяется к каждому следующему прогону, а не только к тому, перед которым
        # его написали.
        note = store.active_note_text(run["card_id"])
        # В режиме GLM 5.x расширение терминов поиска (роль extractor) — тоже в Coding Plan;
        # локально остаются только эмбеддинги (glm_mode.route_extractor).
        with glm_mode.cloud_terms(retriever, council.cloud, cfg, run["id"], on=glm):
            capsule = retriever.build(card, user_constraints=note)
        # M9: запись в docs/plans/done/ ссылается на карточку — пометка в постановку и вопрос владельцу в итог.
        closed = council_closed.done_mentions(run["card_id"])
        council_closed.annotate(capsule, closed)
        log(f"    капсула: {capsule.tokens()['total']} токенов, "
            f"{len(capsule.evidence)} улик, термины: {', '.join(capsule.terms[:6])}"
            + (f"\n    ✎ указание владельца: {note[:80]}" if note else "")
            + (f"\n    ⚑ возможно, уже закрыта: {closed[0][0]}" if closed else ""))
        outcome = council.run_card(run["id"], card, capsule, run["profile"], run["track"],
                                   roles_override=roles_override)
        council_closed.add_question(outcome, closed)
    except cloud_mod.CloudQuotaWait as exc:           # GLM 5.x: квота подписки кончилась посреди прогона
        _release_for_memory(store, run["id"], glm_mode.DEFER_PREFIX + exc.why,
                            not_before=int(exc.until) + cloud_mod.QUOTA_RESUME_GRACE_SECONDS)
        log(f"    ⏸ {exc.why} — прогон вернул на место")
        return
    except CloudUnavailable as exc:                   # облако отказало посреди эскалации
        council.escalation = None
        escalation.defer("runs", run["id"], exc.failures)
        return
    except ollama_mod.MemoryUnavailable as exc:       # память кончилась посреди прогона
        _release_for_memory(store, run["id"], str(exc))
        if blocks is not None:
            blocks.block("runs", run["profile"], str(exc))
        log(f"    ⏸ {exc} — прогон вернул на место")
        return
    except TimeoutError as exc:                       # модельный лок не дождался
        store.finish_run(run["id"], "queued", error=str(exc))
        store.x("UPDATE runs SET status='queued', claimed_by=NULL WHERE id=?", (run["id"],))
        log(f"    ↩ {exc} — вернул в очередь")
        return
    except Exception as exc:                          # noqa: BLE001
        store.finish_run(run["id"], "failed", error=f"{type(exc).__name__}: {exc}")
        log(f"    ✗ упало: {type(exc).__name__}: {exc}")
        return
    finally:
        council.escalation = None
        council.glm_mode = False

    if outcome.status == "deferred":
        _defer_infra(store, run, outcome.reason)
        return
    if outcome.status == "abstained":
        store.finish_run(run["id"], "abstained", outcome.reason,
                         payload={"open_questions": outcome.open_questions,
                                  "reason": outcome.reason},
                         confidence=0.0, readiness=0.0)
    else:
        store.finish_run(run["id"], "done", "", outcome.payload,
                         outcome.confidence, outcome.readiness)

    # P4/Ф2: если есть открытая сессия владельца — прогон в неё (no-op, если нет).
    store.add_session_run_if_open(run["id"])
    if escalation is not None:
        escalation.mark_done("runs", run["id"], escalation.provider, esc_models, waited)

    elapsed = time.time() - started
    log(f"    {outcome.status} за {elapsed:.0f}s"
        + (f" — {outcome.reason}" if outcome.reason else ""))

    # Эскалация: лёгкий проход отработал, решаем, нужен ли тяжёлый.
    if run["profile"] == "fast" and cfg.get("models.profile") == "adaptive" \
            and should_escalate(cfg, card, outcome):
        deep_id = store.enqueue(
            card["card_id"], track=run["track"], profile="deep",
            priority=(run["priority"] or 0) + 1,
            config_hash=cfg.config_hash(), git_sha=git_sha(),
            card_hash=card.get("content_hash") or "",
            # Тяжёлый проход — продолжение той же задачи: шла на GLM 5.x — и он туда же.
            # Отметка — только если её несла сама задача: прогон по тумблеру, отмеченный «только GLM», при сбое
            # квоты больше не вернулся бы к локальным моделям (ревью #156).
            cloud_mode=glm_mode.CLOUD_MODE if glm_mode.requested(run) else "",
        )
        if deep_id:
            log("    ↑ поставлен в очередь на deep-проход")


HEARTBEAT_SECONDS = 60


@contextmanager
def _heartbeat_while(run_id: str, db_path, every: float = HEARTBEAT_SECONDS):
    """Пульс прогона проработки, пока он исполняется. Прогон идёт десятки минут (облачный вызов — 2–8 мин),
    а супервизор возвращает в очередь `running` без пульса дольше `stale_run_ttl_seconds` (15 мин). С одним
    воркером это было безвредно, с облачными полосами тот же прогон взял бы второй исполнитель. Поток пишет
    своим соединением SQLite: соединение воркера в другой поток не передаётся."""
    stop = threading.Event()

    def beat() -> None:
        try:
            with Store(db_path) as hb:
                while not stop.wait(every):
                    try:
                        hb.heartbeat(run_id)
                    except Exception as exc:  # noqa: BLE001 — пульс не должен ронять прогон
                        log(f"    ! пульс {run_id}: {exc}")
        except Exception as exc:  # noqa: BLE001
            log(f"    ! пульс {run_id} не запущен: {exc}")

    thread = threading.Thread(target=beat, name=f"heartbeat-{run_id}", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=5)


def process(cfg, store: Store, council: Council, retriever, run: dict,
            blocks: queue_control.MemoryBlocks | None = None,
            escalation: Escalation | None = None, glm_only: bool = False) -> None:
    with _heartbeat_while(run["id"], store.path):
        _process(cfg, store, council, retriever, run, blocks, escalation, glm_only)


LANE_STATE_KEY = "lane.heartbeat"
LANE_FRESH_SECONDS = 90           # пульс цикла полосы (пишется не реже раза в 20 с, пока она обслуживает)
LANE_TASK_FRESH_SECONDS = 600     # пульс задачи полосы (прогон — раз в 60 с, ревью — на каждой стадии)


def lane_beat(store: Store, worker_id: str) -> None:
    """Полоса обслуживает очередь: пульс цикла (Ollama жив, цикл идёт)."""
    queue_control.set_state(store, LANE_STATE_KEY, {"worker": worker_id, "at": int(time.time())})


def lanes_alive(store: Store, cfg) -> bool:
    """Облачная полоса объявлена в `supervisor.services` И обслуживает очередь: свежий пульс цикла или задача полосы
    со свежим пульсом. Pid мало (ревью #156): полоса без Ollama спит вечно, pid переиспользуется. Нет живой
    полосы — GLM-работу и локальную берёт основной воркер, как без полосы."""
    if not any(str(name).startswith("council-cloud-") for name in cfg.get("supervisor.services", []) or []):
        return False
    now_ts = int(time.time())
    beat = queue_control.get_state(store, LANE_STATE_KEY) or {}
    if isinstance(beat, dict) and int(beat.get("at") or 0) >= now_ts - LANE_FRESH_SECONDS:
        return True
    for table in ("runs", "review_runs"):
        row = store.q1(f"SELECT 1 FROM {table} WHERE status = 'running' AND claimed_by LIKE 'council-cloud-%' "
                       "AND COALESCE(heartbeat_at, 0) >= ? LIMIT 1", (now_ts - LANE_TASK_FRESH_SECONDS,))
        if row:
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Council — worker")
    parser.add_argument("--once", action="store_true", help="разобрать очередь и выйти")
    parser.add_argument("--card", help="поставить и обработать одну карточку немедленно")
    parser.add_argument("--profile", choices=["fast", "deep", "hybrid", "cloud"])
    parser.add_argument("--limit", type=int, default=0, help="максимум прогонов за запуск")
    parser.add_argument("--lane", choices=["main", "cloud"], default="main",
                        help="cloud — дополнительная полоса: берёт задачи только в режиме GLM 5.x")
    args = parser.parse_args()
    cloud_lane = args.lane == "cloud"

    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)

    cfg = config_mod.load(strict=False)
    # pid в id: при старте отличаем осиротевший running от прогона живого воркера.
    worker_id = queue_control.worker_id("council-cloud" if cloud_lane else "council")

    with Store() as store:
        client = ollama_mod.build(cfg, store, holder=worker_id)
        if not client.alive():
            log("Ollama не отвечает — воркер простаивает (не падаю, чтобы супервизор "
                "не крутил рестарты)")
            if args.once or args.card:
                return 1
            while not _stopping:
                time.sleep(15)
            return 0

        retriever = retrieval_mod.Retriever(cfg, store, client)
        cloud_client = cloud_mod.build(cfg, store, logger=log)
        # Квота подписки в режиме GLM 5.x — исключение из chat(): прогон любого пути ждёт сброса на своём месте.
        cloud_client.raise_on_quota = True
        if cfg.cloud_enabled():
            budget = cloud_client.budget
            spent = cloud_client.spent_today()
            log(f"облачный ярус включён: judge={cfg.cloud_role('judge')}, "
                f"сегодня ${spent['usd']:.4f}/${budget.max_usd_per_day}, "
                f"{spent['calls']}/{budget.max_calls_per_day} вызовов")
            g = glm_mode.settings(cfg)
            log("режим GLM 5.x: " + ("включён в шапке" if glm_mode.is_on(store)
                                     else "в шапке выключен, действует по отметке задачи")
                + f" — лимиты режима {g['max_calls_per_window']} за {g['window_hours']} ч, "
                f"{g['max_calls_per_run']} на прогон")
        council = Council(cfg, store, client, retriever, logger=log, cloud_client=cloud_client)
        # Ревью (вкладка «Ревью») исполняется этим же процессом: локальный инференс на машине строго
        # последовательный (CLAUDE.local.md). Между процессами его держит файловый лок
        # (ollama.local_inference_slot); параллельно — только облачные полосы (`--lane cloud`) в режиме GLM 5.x.
        reviewer = ReviewEngine(cfg, store, client, retriever, cloud_client, logger=log)
        # Облачная эскалация задач, ждущих памяти дольше порога (§17.4, cloud_escalation.py).
        escalator = Escalation(cfg, store, client, cloud_client, logger=log)

        profile_default = cfg.get("models.profile", "fast")
        profile = args.profile or ("fast" if profile_default == "adaptive" else profile_default)

        # Профиль на облачных моделях без включённого облака — это не «деградация до
        # локального», это прогон, где КАЖДАЯ роль вернёт отказ и карточка воздержится,
        # потратив время на пустые раунды. Лучше сказать сразу и не начинать.
        if profile in CLOUD_PROFILES and not cfg.cloud_enabled():
            log(f"профиль `{profile}` работает на облачных моделях, а облако выключено. "
                f"Включить: AI_COUNCIL_CLOUD=1 или models.cloud.enabled=true в config.toml")
            return 1

        if args.card:
            # Только карточки t-boards и черновики: снимок Notion — архив, по названию его не ищем.
            card = store.find_card(args.card) or store.q1(
                "SELECT * FROM cards WHERE (origin = 'tboards' OR db = 'draft') "
                "AND (backlog_id = ? OR title LIKE ?) ORDER BY fetched_at DESC LIMIT 1",
                (args.card, f"%{args.card}%"))
            if not card:
                log(f"карточка {args.card} не найдена — сначала прочитать её из t-boards: "
                    f"python3 infra/ai-council/tboards.py card <ключ>")
                return 1
            run_id = store.enqueue(
                card["card_id"],
                track="half_baked" if card["half_baked"] else "elaborate",
                profile=profile, priority=9, config_hash=cfg.config_hash(),
                git_sha=git_sha(), card_hash=card.get("content_hash") or "", dedupe=False)
            run = store.claim_run(worker_id)
            while run and run["id"] != run_id:        # чужой прогон впереди — вернём в очередь
                store.x("UPDATE runs SET status='queued', claimed_by=NULL WHERE id=?",
                        (run["id"],))
                run = store.claim_run(worker_id)
            if run:
                process(cfg, store, council, retriever, run)
            council.close()
            retriever.close()
            return 0

        processed = 0
        last_reap = 0.0
        # Облачная полоса поднята супервизором и жива — облачную работу основной воркер ей и оставляет.
        lanes_was: bool | None = None
        lane_beat_at = 0.0
        if cloud_lane:
            reviewer.glm_only = True      # ревью полосы — только GLM; пропал — откладывается, не идёт локально
        # Перезапуск продолжает с того же места: прогоны, оборванные остановкой прежнего
        # воркера, — сразу обратно в очередь, а не через 15 минут reap_stale.
        recovered = queue_control.recover_orphans(store, worker_id)
        if any(recovered.values()):
            log(f"подхвачено после остановки: {recovered}")
        blocks = queue_control.MemoryBlocks(store)
        was_paused = False
        ollama_down = False
        quota_logged = 0
        glm_was: bool | None = None
        while not _stopping:
            settings = reviewer.rs.settings()
            # Тумблер «всё на GLM 5.x» в шапке (§17.6) — на каждом цикле, без рестарта.
            glm_was, glm_on = _glm_tick(cfg, store, cloud_client, glm_was)
            if time.time() - last_reap > 300:
                reviewer.rs.reap_stale(max(2400, int(settings["max_wall_seconds"]) + 600))
                last_reap = time.time()
            # Глобальная пауза (queue_control.pause): текущий прогон доделан, новых не берём,
            # очередь не трогаем — «продолжить» продолжит ровно отсюда.
            paused = queue_control.is_paused(store)
            if paused:
                if not was_paused:
                    log(f"очередь на паузе ({paused.get('by', '?')}) — жду продолжения")
                was_paused = True
                _idle(5)
                continue
            if was_paused:
                log("очередь продолжена")
                was_paused = False
            # Маршруты захвата (решение владельца 2026-10-15: «консилиум должен работать всегда»): пока GLM 5.x
            # доступен, облачную работу берёт облачная полоса, основной воркер не простаивает на локальных моделях;
            # GLM недоступен (квота, сбой Z.AI) — задачи «только для GLM» ждут во второй очереди, остальные идут
            # локально. Раньше воркер в режиме спал целиком до сброса квоты (474 проработки — сутки без движения).
            glm_ok, glm_why = glm_mode.available_now(cfg, cloud_client)
            if glm_on and not glm_ok and quota_logged != hash(glm_why):
                log(f"⏸ GLM 5.x недоступен: {glm_why} — задачи «только для GLM» ждут, остальные идут локально")
                quota_logged = hash(glm_why)
            if cloud_lane and time.time() - lane_beat_at > 20:
                lane_beat(store, worker_id)
                lane_beat_at = time.time()
            lanes = False if cloud_lane else lanes_alive(store, cfg)
            if not cloud_lane and lanes != lanes_was:
                log("облачная полоса жива: GLM-работа — в ней, здесь — локальные модели по одной" if lanes
                    else "облачной полосы нет — GLM-работу и локальную берёт этот воркер")
                lanes_was = lanes
            routes = plan_routes(glm_on, glm_ok, glm_mode.effective_for_runs(store, cfg), cloud_lane, lanes,
                                 cloud_on=bool(cfg.cloud_enabled()))
            review_on = settings["worker_enabled"] and _pipeline_on("councilReview")
            if routes.idle:
                if args.once:
                    break
                _idle(15)
                continue
            # Дрейф M4: пока демон Ollama не отвечает, новых прогонов и ревью не берём. Иначе каждый прогон очереди
            # падал бы мгновенно (кэш-маркер сбоя) и уходил в откладывание — очередь сгорела бы за минуты. Капсула и
            # в режиме GLM строится на локальных эмбеддингах, поэтому проверка — для любого маршрута.
            if not client.alive():
                if not ollama_down:
                    log("Ollama не отвечает — новые прогоны и ревью не беру, жду")
                    ollama_down = True
                if args.once:
                    break
                _idle(15)
                continue
            if ollama_down:
                log("Ollama снова отвечает — продолжаю")
                ollama_down = False
            # Облачная эскалация (§17.4): задачи профилей, которые ПРЯМО СЕЙЧАС ждут память, и ждут её дольше
            # порога, — только там, где задача идёт локально (в режиме GLM L-моделей нет). Пока облако на паузе
            # после отказа всех провайдеров (ready() = False), сюда не заходим.
            # Эскалация — задачам, которые идут локально: маршрут local или any без живого режима для их вида.
            glm_live = glm_on and glm_ok
            esc_reviews = routes.reviews == "local" or (routes.reviews == "any" and not glm_live)
            esc_runs = routes.runs == "local" or (routes.runs == "any" and not (glm_live and
                                                                                glm_mode.effective_for_runs(store, cfg)))
            if not cloud_lane and escalator.ready():
                if review_on and esc_reviews:
                    esc_review = escalator.claim("review_runs", worker_id, blocks.active("review"))
                    if esc_review is not None:
                        esc_review = reviewer.rs.run(esc_review["id"]) or esc_review
                        _run_review(cfg, reviewer, esc_review, blocks, escalator)
                        processed += 1
                        continue
                if esc_runs:
                    esc_run = escalator.claim("runs", worker_id, blocks.active("runs"))
                    if esc_run is not None:
                        process(cfg, store, council, retriever, esc_run, blocks, escalator)
                        processed += 1
                        continue
            # Ревью — явный запрос владельца (или автозапуск доски) и завал «на ревью»; проработки идут фоном.
            # Поэтому по умолчанию ревью берётся первым. Профили, заблокированные memory-guard, пропускаются —
            # их прогоны ждут на своих местах (фикс голодания 2026-10-06); в облачной полосе блоков нет.
            review_first = review_on and settings["priority_over_elaboration"]
            if review_first and routes.reviews:
                review_run = _claim_review(reviewer, worker_id, blocks, routes.reviews, glm_live)
                if review_run is not None:
                    _run_review(cfg, reviewer, review_run, blocks)
                    processed += 1
                    continue
            run = None
            if routes.runs:
                run = store.claim_run(worker_id, route=routes.runs,
                                      exclude_profiles=[] if cloud_lane else blocks.active("runs"))
            if run is None and review_on and not review_first and routes.reviews:
                review_run = _claim_review(reviewer, worker_id, blocks, routes.reviews, glm_live)
                if review_run is not None:
                    _run_review(cfg, reviewer, review_run, blocks)
                    processed += 1
                    continue
            if run is None:
                if args.once:
                    break
                _idle(5)
                continue
            store.heartbeat(run["id"])
            process(cfg, store, council, retriever, run, blocks, glm_only=cloud_lane)
            processed += 1
            if args.limit and processed >= args.limit:
                break

        council.close()
        retriever.close()
        log(f"обработано прогонов: {processed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
