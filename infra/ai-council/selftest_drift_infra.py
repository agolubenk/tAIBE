#!/usr/bin/env python3
"""AI Council — самопроверка дрейфа M4 и M5 (council_infra.py, §17.8). Только stdlib, сети и Ollama нет.

Вызывается из selftest.py: классификация сбоев (демон, кэш-маркер, HTTP 5xx, занятый слот, зависший вызов; таймаут
генерации и невалидный JSON — не инфраструктура), исход deferred в трёх точках прогона, откладывание воркером с
растущей паузой и воздержание после двух, повтор прогона без «UNIQUE constraint failed: proposals.id», повтор арбитра
компактным пакетом и результат без слияния с уверенностью не выше 0.5.
"""
from __future__ import annotations

import contextlib
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

F1 = "infra/ai-council/council.py"        # существует в репозитории — верификатор его подтвердит
DAEMON = "сеть/демон: <urlopen error [Errno 61] Connection refused>"
MARKER = "ollama недоступна (кэш-маркер сбоя)"
BAD_JSON = "ответ не распарсился как JSON: Expecting value: line 1 column 1 (char 0)"


class _Client:
    """Скриптованный Ollama: dict — удачный ответ; ("fail", ошибка) — отказ; ("slow", dict, ms) — удачный, но долгий."""

    request_timeout = 300

    def __init__(self, script: list):
        self.script = list(script)
        self.calls = 0

    def chat(self, model, messages, **_kw):
        self.calls += 1
        item = self.script.pop(0) if self.script else ("fail", "скрипт исчерпан")
        if isinstance(item, tuple) and item[0] == "fail":
            return SimpleNamespace(ok=False, text="", data=None, error=item[1], ms=0, model=model,
                                   tokens_in=0, tokens_out=0)
        data, ms = (item[1], item[2]) if isinstance(item, tuple) else (item, 5)
        return SimpleNamespace(ok=True, text=json.dumps(data, ensure_ascii=False), data=data, error="", ms=ms,
                               model=model, tokens_in=0, tokens_out=0)

    def large_model(self, _model):
        return contextlib.nullcontext()


def _payload(goal: str = "добавить take в выборку консилиума") -> dict:
    return {"abstain": False, "goal": goal, "non_goals": [],
            "decomposition": [{"id": "s1", "what": "добавить take", "files": [F1], "est": "S", "from": ["p1"]}],
            "touched": {"files": [F1], "routes": [], "prisma_models": [], "rpcs": [], "modules": []},
            "risks": [], "acceptance": ["выборка ограничена take"], "verification_cmd": "turbo run typecheck",
            "open_questions": [], "alternative_considered": {"what": "кэш", "why_rejected": "не лечит причину"},
            "confidence": 0.8}


def _review(council_mod) -> dict:
    return {"scores": {k: 3 for k in council_mod.RUBRIC_KEYS}, "blocking_objections": [], "best_part": "take"}


def _council(tmp: Path, name: str, script: list, wall: int = 420):
    import config as config_mod
    import council as council_mod
    from store import Store
    cfg = config_mod.load(HERE / "config.toml", strict=False)
    cfg.data.setdefault("sources", {}).setdefault("rag", {})["db"] = str(tmp / "no-rag.db")
    section = cfg.data.setdefault("council", {})
    section["max_wall_seconds_per_card"] = wall
    section["self_consistency"] = {}
    section["adversarial"] = {"enabled": False}
    store = Store(tmp / f"{name}.db")
    client = _Client(script)
    council = council_mod.Council(cfg, store, client, retriever=None, logger=lambda _m: None)
    return council, store, client


def _run(council, run_id: str):
    from retrieval import Capsule
    card = {"card_id": "c-m4", "db": "tasks", "title": "take в выборке", "modules": "[]", "content_hash": "h"}
    roles = {"proposer.code": "m-code", "proposer.arch": "m-arch", "arbiter": "m-arb"}
    return council.run_card(run_id, card, Capsule(card_id="c-m4", pinned=f"Поправить {F1}: не хватает take"),
                            "fast", "elaborate", roles_override=roles)


def _classify(check) -> None:
    import council_infra as ci
    cases = [(False, DAEMON, 0), (False, MARKER, 0), (False, "HTTP 500: model runner has unexpectedly stopped", 0),
             (False, "таймаут вызова (300s): локальный инференс занят другим процессом дольше 300 с", 0)]
    check("M4: демон, кэш-маркер, HTTP 5xx и занятый слот — сбой инфраструктуры",
          all(ci.infra_event(ok, err, ms, 300) for ok, err, ms in cases))
    quiet = [(False, "таймаут вызова (300s): timed out", 0), (False, BAD_JSON, 0), (False, "HTTP 404: model not found", 0),
             (True, "", 590_000), (True, "", 660_000)]
    check("M4: таймаут генерации, невалидный JSON, 404 и долгий, но законный вызов — не инфраструктура",
          not any(ci.infra_event(ok, err, ms, 300) for ok, err, ms in quiet))
    check("M4: вызов дольше двух таймаутов — машина спала или зависла (замер: 16–47 мин при 300 с)",
          "спала" in ci.infra_event(True, "", 1_991_183, 300) and ci.infra_event(True, "", 939_342, 300) != "")
    check("M4: растущая пауза 15 → 30 мин", (ci.defer_pause(0), ci.defer_pause(1), ci.defer_pause(5)) == (900, 1800, 1800))


def _deferred_points(check, tmp: Path, council_mod) -> None:
    council, store, _c = _council(tmp, "m4-noprop", [("fail", DAEMON), ("fail", MARKER)])
    out = _run(council, "run-m4a")
    check("M4: ни одного предложения из-за демона → deferred", out.status == "deferred"
          and out.reason.startswith("ни одного предложения: proposer.arch: ollama недоступна"), f"{out.status} {out.reason}")
    council.close(); store.close()

    council, store, _c = _council(tmp, "m4-json", [("fail", BAD_JSON), ("fail", BAD_JSON)])
    out = _run(council, "run-m4b")
    check("M4: ни одного предложения из-за модели (JSON) → воздержание, как раньше", out.status == "abstained"
          and out.reason == "ни одна модель не дала валидного предложения", f"{out.status} {out.reason}")
    council.close(); store.close()

    council, store, _c = _council(tmp, "m4-stall", [("slow", _payload(), 2_000_000), _payload()], wall=0)
    out = _run(council, "run-m4c")
    check("M4: время ушло на зависший вызов, рецензий нет → deferred", out.status == "deferred"
          and "рецензий не было" in out.reason and "спала" in out.reason, f"{out.status} {out.reason}")
    council.close(); store.close()

    council, store, _c = _council(tmp, "m4-slow", [_payload(), _payload()], wall=0)
    out = _run(council, "run-m4d")
    check("M4: дедлайн без сбоя (медленные модели) → воздержание «лучшая оценка 0.0», как раньше",
          out.status == "abstained" and out.reason.startswith("лучшая оценка 0.0"), f"{out.status} {out.reason}")
    council.close(); store.close()


def _arbiter(check, tmp: Path, council_mod) -> None:
    ok_props = [_payload(), _payload(), _review(council_mod), _review(council_mod)]
    council, store, _c = _council(tmp, "m5-compact", ok_props + [("fail", BAD_JSON), _payload()])
    out = _run(council, "run-m5a")
    check("M5: арбитр не ответил → повтор компактным пакетом → слияние", out.status == "done"
          and out.payload["provenance"]["merge"] == "compact", f"{out.status} {out.reason}")
    prompt = (store.q1("SELECT prompt FROM messages WHERE run_id='run-m5a' AND round=41") or {}).get("prompt", "")
    user = prompt.split("\n\n---\n\n", 1)[-1]             # system — промпт арбитра, он описывает и полный пакет
    check("M5: компактный пакет — без рецензий и отчёта верификатора",
          "ДВА ЛУЧШИХ ПРЕДЛОЖЕНИЯ" in user and "оценка_рецензентов" not in user and "верификатор" not in user, user[:300])
    council.close(); store.close()

    council, store, _c = _council(tmp, "m5-none", ok_props + [("fail", BAD_JSON), ("fail", BAD_JSON)])
    out = _run(council, "run-m5b")
    prov = (out.payload or {}).get("provenance", {})
    check("M5: снова нет → лучшее предложение без слияния, уверенность ≤ 0.5, спираль пропущена",
          out.status == "done" and prov.get("merge") == "none" and out.confidence <= 0.5
          and "без слияния" in prov.get("adversarial", {}).get("stop_reason", "")
          and out.payload["decomposition"][0].get("from") in (["p1"], ["p2"]), f"{out.status} {out.confidence}")
    council.close(); store.close()

    blip = [_payload(), _payload(), ("fail", DAEMON), _review(council_mod)]      # сбой демона у рецензента
    council, store, _c = _council(tmp, "m5-blip", blip + [("fail", BAD_JSON), ("fail", BAD_JSON)])
    out = _run(council, "run-m5d")
    check("M4+M5: сбой демона до арбитра не откладывает прогон, если сам арбитр ответил плохо (JSON)",
          out.status == "done" and (out.payload or {}).get("provenance", {}).get("merge") == "none"
          and len(council._infra) == 1, f"{out.status} {out.reason}")
    council.close(); store.close()

    council, store, client = _council(tmp, "m5-infra", ok_props + [("fail", DAEMON), ("fail", MARKER)])
    out = _run(council, "run-m5c")
    check("M4+M5: арбитр молчит из-за демона → deferred, а не результат без слияния",
          out.status == "deferred" and out.reason.startswith("арбитр не ответил"), f"{out.status} {out.reason}")
    before = store.q1("SELECT COUNT(*) n FROM proposals WHERE run_id='run-m5c'")["n"]
    client.script = ok_props + [_payload()]
    try:
        again = _run(council, "run-m5c")
        error = ""
    except Exception as exc:                     # noqa: BLE001 — сама проверка и ловит падение
        again, error = None, f"{type(exc).__name__}: {exc}"
    rows = store.q1("SELECT (SELECT COUNT(*) FROM proposals WHERE run_id='run-m5c') p, "
                    "(SELECT COUNT(*) FROM reviews WHERE run_id='run-m5c') r")
    check("повтор того же прогона после откладывания: без UNIQUE на proposals.id, строки прошлой попытки сняты",
          not error and again is not None and again.status == "done" and before == 2 and rows["p"] == 2
          and rows["r"] == 2, error or f"{rows}")
    council.close(); store.close()


def _worker(check, tmp: Path) -> None:
    import council_infra as ci
    import council_worker as worker
    from store import Store
    store = Store(tmp / "m4-worker.db")
    run_id = store.enqueue("c-m4", dedupe=False)
    run = store.claim_run("w-m4")
    seen = []
    for _ in range(3):
        worker._defer_infra(store, run, "ни одного предложения: proposer.code: сеть/демон")
        row = store.q1("SELECT status, attempts, not_before, infra_deferrals, error, outcome FROM runs WHERE id=?",
                       (run_id,))
        seen.append(row)
        if row["status"] == "queued":
            store.x("UPDATE runs SET not_before=NULL WHERE id=?", (run_id,))
            run = store.claim_run("w-m4")
    now = int(time.time())
    first, second, third = seen
    check("M4 воркер: отложен без сожжённой попытки, пауза 15 мин, причина с пометкой",
          first["status"] == "queued" and first["attempts"] == 0 and first["infra_deferrals"] == 1
          and abs(first["not_before"] - now - 900) <= 5 and first["error"].startswith(ci.DEFER_PREFIX), str(first))
    check("M4 воркер: второй раз — 30 мин", second["status"] == "queued" and second["infra_deferrals"] == 2
          and abs(second["not_before"] - now - 1800) <= 5, str(second))
    check("M4 воркер: третий раз — воздержание «ресурс локальных моделей»", third["status"] == "abstained"
          and third["outcome"].startswith(ci.ABSTAIN_PREFIX), str(third))
    store.close()


def run(tmp: Path, check) -> None:
    import council as council_mod
    _classify(check)
    _deferred_points(check, tmp, council_mod)
    _arbiter(check, tmp, council_mod)
    _worker(check, tmp)
