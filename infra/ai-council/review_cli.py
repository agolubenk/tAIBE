#!/usr/bin/env python3
"""AI Council — CLI ревью. Он же бэкенд MCP-инструментов council_review_* (mcp_server.py).

    python3 infra/ai-council/review_cli.py queue [--refresh] [--board bugs|tasks]
    python3 infra/ai-council/review_cli.py start --card <OPS-26|id|next|all> [--profile <имя|id>]
                                                 [--agents a,b] [--method ADVERSARIAL] [--note "…"]
    python3 infra/ai-council/review_cli.py prepare --card <ref> [--profile …]
    python3 infra/ai-council/review_cli.py result <run_id | --card ref>
    python3 infra/ai-council/review_cli.py decide <run_id> --approve|--reject [--comment "…"]
    python3 infra/ai-council/review_cli.py cancel <run_id>
    python3 infra/ai-council/review_cli.py config
    python3 infra/ai-council/review_cli.py worker [--once]   # разбор очереди ревью в этом процессе

Исполняет прогоны council_worker под супервизором (ревью раньше проработок); `worker`
— для ручного разбора, когда супервизор не поднят. Два воркера одновременно не
запускать: локальный инференс на этой машине — строго последовательно.

Вывод — JSON при --json (так его читает MCP), иначе человекочитаемый.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as config_mod                              # noqa: E402
import review_catalog as cat                             # noqa: E402
import review_service as svc                             # noqa: E402
from cloud_escalation import CloudUnavailable            # noqa: E402
import glm_mode                                          # noqa: E402
from cloud import QUOTA_RESUME_GRACE_SECONDS, CloudQuotaWait  # noqa: E402
from ollama import MemoryUnavailable                     # noqa: E402
from review_store import ReviewStore                     # noqa: E402
from store import Store                                  # noqa: E402


def _out(payload, as_json: bool, human=None) -> int:
    if as_json or human is None:
        print(json.dumps(payload, ensure_ascii=False, indent=1, default=str))
    else:
        human(payload)
    return 0 if not (isinstance(payload, dict) and payload.get("ok") is False) else 1


def _run_view(rs: ReviewStore, run: dict, full: bool = False) -> dict:
    res = run.get("result") or {}
    view = {k: run.get(k) for k in ("id", "card_id", "board", "card_title", "status", "verdict",
                                    "confidence", "summary", "profile_name", "method",
                                    "transition_state", "transition_target", "transition_note",
                                    "comment_state", "requested_by", "error", "wall_ms")}
    view["findings"] = [{k: f.get(k) for k in ("id", "by", "severity", "title", "recommendation",
                                               "refuted")} for f in res.get("findings") or []][:20]
    view["votes"] = {k: {"vote": v.get("vote"), "confidence": v.get("confidence")}
                     for k, v in (res.get("votes") or {}).items()}
    view["judge"] = {k: (res.get("judge") or {}).get(k) for k in ("verdict", "dissent", "next_steps")}
    view["trace"] = res.get("trace")
    if full:
        view["steps"] = [{k: s.get(k) for k in ("stage_no", "stage_type", "agent_key", "model", "ok",
                                               "error", "ms", "tokens_in", "tokens_out")}
                         for s in rs.steps(run["id"])]
    return view


def cmd_queue(cfg, rs, args):
    sync = svc.sync_queue(cfg, rs, boards=[args.board] if args.board else None) if args.refresh else None
    rows = rs.queue(args.board)
    payload = {"ok": True, "synced": sync, "count": len(rows), "cards": [{
        "card_id": c["card_id"], "ticket": c.get("ticket"), "board": c["board"], "title": c["title"],
        "backlog_id": c["backlog_id"],
        "severity": c["severity"], "priority": c["priority"], "half_baked": bool(c["half_baked"]),
        "url": c["url"], "last_review": ({k: c["last_run"].get(k) for k in
                                          ("id", "status", "verdict", "transition_state")}
                                         if c.get("last_run") else None)} for c in rows]}

    def human(p):
        if p["synced"]:
            print(f"синхронизация: {p['synced']}")
        print(f"в очереди ревью: {p['count']}")
        for c in p["cards"]:
            last = c["last_review"]
            mark = f"{last['verdict'] or last['status']}" if last else "не ревьюилась"
            print(f"  [{c['board']}] {c['ticket'] or c['backlog_id'] or c['card_id'][:8]:10} {c['title'][:70]:70} — {mark}")
    return _out(payload, args.json, human)


def _request(args) -> dict:
    req = {"agents": [a.strip() for a in (args.agents or "").split(",") if a.strip()],
           "method": (args.method or "").upper(), "note": args.note or ""}
    if getattr(args, "glm", False):
        req["cloud_mode"] = "glm5"          # §17.6: этот прогон целиком на GLM Coding API (5.x)
    return req


def cmd_stats(cfg, rs, args):
    import review_stats
    data = (review_stats.replay(rs.s, args.limit) if args.what == "replay"
            else review_stats.agent_stats(rs.s, args.limit))
    if args.what == "replay" and not args.json:
        data = {k: v for k, v in data.items() if k != "rows"}

    def human(d):
        print(json.dumps(d, ensure_ascii=False, indent=1))
    return _out(data, args.json, human)


def cmd_start(cfg, rs, args):
    if args.refresh:
        svc.sync_queue(cfg, rs)
    res = svc.enqueue(cfg, rs, args.card, args.profile or "", args.source, _request(args),
                      board=args.board or "", priority=args.priority, force=args.force)

    def human(p):
        if not p.get("ok"):
            print("✗", p.get("error"))
            return
        for q in p["queued"]:
            print(f"  ✓ {q['run_id']} · {q['title'][:70]} · профиль «{q['profile']}»")
        for s in p.get("skipped") or []:
            print(f"  · пропуск: {s['title'][:60]} — {s['why']}")
        print("Исполнит council_worker (ревью раньше проработок). Итог: review_cli.py result <run_id>")
    return _out(res, args.json, human)


def cmd_prepare(cfg, rs, args):
    res = svc.prepare(cfg, rs, args.card, args.profile or "", _request(args), live=not args.offline)
    res.pop("dossier_preview", None) if not args.dossier else None

    def human(p):
        for c in p.get("checks") or []:
            print(f"  {'✓' if c['ok'] else '✗'}{'⚠' if c.get('level') == 'warn' else ' '} {c['text']}")
        for key, a in ((p.get("plan") or {}).get("agents") or {}).items():
            print(f"    {key:22} {a['model']:34} ctx={a['num_ctx']} out={a['num_predict']} "
                  f"вход≈{a['input_budget']}")
    return _out(res, args.json, human)


def cmd_result(cfg, rs, args):
    run = None
    if args.run_id:
        run = rs.run(args.run_id)
    elif args.card:
        card = rs.find_card(args.card)
        last = rs.runs(card_id=card["card_id"], limit=1) if card else []
        run = rs.run(last[0]["id"]) if last else None
    if not run:
        return _out({"ok": False, "error": "прогон не найден"}, args.json, lambda p: print("✗", p["error"]))
    view = _run_view(rs, run, full=args.full)

    def human(v):
        print(f"{v['id']} · {v['card_title'][:70]}")
        print(f"  статус: {v['status']} · вердикт: {v['verdict'] or '—'} ({v['confidence'] or 0:.2f})")
        print(f"  итог: {v['summary'] or v['error'] or '—'}")
        for f in v["findings"]:
            print(f"   {'~' if f['refuted'] else '•'} [{f['severity']}] {f['title']}")
        print(f"  переход: {v['transition_state']} {v['transition_target'] or ''} {v['transition_note'] or ''}")
    return _out({"ok": True, **view}, args.json, human)


def cmd_decide(cfg, rs, args):
    if args.approve == args.reject:
        return _out({"ok": False, "error": "нужен ровно один из --approve / --reject"}, args.json)
    res = svc.decide_transition(cfg, rs, args.run_id, args.approve, args.source, args.comment or "")
    return _out(res, args.json, lambda p: print("✓" if p.get("ok") else "✗", p.get("state") or p.get("error")))


def cmd_cancel(cfg, rs, args):
    try:
        state = rs.request_cancel(args.run_id)
    except cat.ValidationError as exc:
        return _out({"ok": False, "error": str(exc)}, args.json)
    return _out({"ok": True, "state": state}, args.json, lambda p: print(p["state"]))


def cmd_config(cfg, rs, args):
    payload = {"ok": True, "settings": rs.settings(), "boards": rs.boards(),
               "profiles": [{"id": p["id"], "name": p["name"], "default": p["is_default"],
                             "method": p["spec"]["method"], "mode": p["spec"]["participant_mode"],
                             "agents": p["spec"]["agents"]} for p in rs.profiles()],
               "agents": [{"key": a["key"], "label": a["label"], "kind": a["kind"],
                           "model": a.get("model") or "(наследует)", "can_block": a.get("can_block"),
                           "enabled": a.get("enabled", True)} for a in rs.agents()],
               "methods": {k: v["label"] for k, v in cat.METHODS.items()},
               "counts": rs.counts()}
    return _out(payload, args.json)


def cmd_worker(cfg, rs, args):
    import cloud as cloud_mod
    import ollama as ollama_mod
    import retrieval as retrieval_mod
    from review_engine import ReviewEngine
    worker_id = f"review-cli-{time.strftime('%H%M%S')}"
    client = ollama_mod.build(cfg, rs.s, holder=worker_id)
    if not client.alive():
        print("Ollama не отвечает")
        return 1
    retriever = retrieval_mod.Retriever(cfg, rs.s, client)
    engine = ReviewEngine(cfg, rs.s, client, retriever, cloud_mod.build(cfg, rs.s, logger=print), print)
    n = 0
    while True:
        run = rs.claim(worker_id)
        if run is None:
            if args.once:
                break
            time.sleep(5)
            continue
        outcome, why = process_run(cfg, engine, run, print)
        if outcome == "ok":
            n += 1
        elif outcome == "memory":
            print(f"    ⏸ ревью: {why} — прогон на месте, жду память")
            time.sleep(60)
    retriever.close()
    print(f"ревью обработано: {n}")
    return 0


def process_run(cfg, engine, run: dict, log, escalation=None) -> tuple[str, str]:
    """Общая обвязка прогона для council_worker и CLI-воркера.

    Возвращает (исход, причина): ok | memory | retry | cloud_wait | failed. На `memory` прогон
    уже возвращён на своё место в очереди (rs.release) — блокировать профиль решает вызывающий
    (queue_control.MemoryBlocks), иначе он будет захвачен снова в следующем цикле. `cloud_wait`
    — повтор уже назначен (эскалация или режим GLM 5.x ждёт окно подписки, not_before): ни
    блокировать, ни разблокировать профиль не нужно. `failed` — итог с причиной записан, моделей
    не грузили: блок памяти профиля этим прогоном не подтверждён и не снят."""
    rs = engine.rs
    try:
        res = engine.process(run, escalation=escalation)
    except CloudQuotaWait as exc:                        # GLM 5.x: квота подписки кончилась посреди ревью
        if not glm_mode.requested(run.get("request")):
            # Без отметки — не ждём сброса: квота отмечена, следующий захват пойдёт локально (2026-10-15).
            rs.release(run["id"], exc.why, not_before=None)
            log(f"    ↩ {exc.why} — ревью без отметки вернул в очередь: пойдёт локально")
            return "cloud_wait", exc.why
        rs.release(run["id"], glm_mode.DEFER_PREFIX + exc.why,
                   not_before=int(exc.until) + QUOTA_RESUME_GRACE_SECONDS)
        log(f"    ⏸ {exc.why} — ревью вернул на место")
        return "cloud_wait", exc.why
    except CloudUnavailable as exc:                      # эскалация: облако недоступно
        if escalation is None:
            rs.release(run["id"], str(exc))
            return "retry", str(exc)
        decision = escalation.defer("review_runs", run["id"], exc.failures)
        return "cloud_wait", decision.why
    except MemoryUnavailable as exc:                     # memory-guard: L-модели некуда встать
        rs.release(run["id"], str(exc))
        return "memory", str(exc)
    except TimeoutError as exc:                          # модельный лок держит другой воркер
        rs.s.x("UPDATE review_runs SET status='queued', claimed_by=NULL WHERE id=?", (run["id"],))
        log(f"    ↩ {exc} — ревью вернул в очередь")
        return "retry", str(exc)
    except Exception as exc:                             # noqa: BLE001
        rs.finish(run["id"], "failed", error=f"{type(exc).__name__}: {exc}")
        log(f"    ✗ ревью упало: {type(exc).__name__}: {exc}")
        return "failed", str(exc)
    if res.get("status") == "deferred":                  # GLM 5.x: окно занято (glm_mode.review_gate)
        return "cloud_wait", str(res.get("why") or "")
    if res.get("status") == "failed":                    # итог с причиной уже записан (rs.finish)
        return "failed", str(res.get("why") or "")
    if res.get("status") == "done":
        try:
            svc.after_run(cfg, rs, run["id"], log=log)
        except Exception as exc:                         # noqa: BLE001
            log(f"    ✗ политика итога не применена: {type(exc).__name__}: {exc}")
    return "ok", ""


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Council — ревью")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--source", default="cli", choices=["cli", "mcp", "ui"],
                        help="кто инициатор (для аудита)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("queue")
    p.add_argument("--refresh", action="store_true")
    p.add_argument("--board", choices=list(cat.BOARDS))
    for name in ("start", "prepare"):
        p = sub.add_parser(name)
        p.add_argument("--card", default="next")
        p.add_argument("--profile")
        p.add_argument("--agents")
        p.add_argument("--method")
        p.add_argument("--note")
        p.add_argument("--board", choices=list(cat.BOARDS))
        p.add_argument("--glm", action="store_true", help="все агенты на GLM Coding API (5.x)")
        if name == "start":
            p.add_argument("--priority", type=int, default=5)
            p.add_argument("--force", action="store_true")
            p.add_argument("--refresh", action="store_true")
        else:
            p.add_argument("--offline", action="store_true")
            p.add_argument("--dossier", action="store_true")
    p = sub.add_parser("result")
    p.add_argument("run_id", nargs="?")
    p.add_argument("--card")
    p.add_argument("--full", action="store_true")
    p = sub.add_parser("decide")
    p.add_argument("run_id")
    p.add_argument("--approve", action="store_true")
    p.add_argument("--reject", action="store_true")
    p.add_argument("--comment")
    p = sub.add_parser("cancel")
    p.add_argument("run_id")
    sub.add_parser("config")
    p = sub.add_parser("stats")
    p.add_argument("what", nargs="?", default="agents", choices=["agents", "replay"])
    p.add_argument("--limit", type=int, default=0)
    p = sub.add_parser("worker")
    p.add_argument("--once", action="store_true")
    args = parser.parse_args()

    cfg = config_mod.load(strict=False)
    with Store() as store:
        rs = ReviewStore(store)
        handler = {"queue": cmd_queue, "start": cmd_start, "prepare": cmd_prepare,
                   "result": cmd_result, "decide": cmd_decide, "cancel": cmd_cancel,
                   "config": cmd_config, "worker": cmd_worker, "stats": cmd_stats}[args.cmd]
        return handler(cfg, rs, args)


if __name__ == "__main__":
    sys.exit(main())
