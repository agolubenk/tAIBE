#!/usr/bin/env python3
"""AI Council — HTTP-маршруты вкладки «Ревью» (`/api/review/*`) для gateway.py.

Шлюз живёт только на петле и без авторизации (gateway.serve). На доску консилиум не пишет
(OPS-26): «Подтвердить переход» на прогоне отмечает решение владельца в базе, карточку на
доске t-boards переносит агент под арендой или владелец. Очередь — колонки ревью t-boards,
обновляется только по запросу (POST /api/review/sync).

GET  /api/review/state                       — всё для вкладки одним запросом
GET  /api/review/queue?board=&left=1
GET  /api/review/runs?card_id=&status=&limit=
GET  /api/review/runs/<id>                   — прогон + шаги (без текстов)
GET  /api/review/steps/<id>                  — один вызов модели полностью
GET  /api/review/statuses?board=             — статусы для политики доски (каталог slug t-boards)
GET  /api/review/profiles/<id>/versions
GET  /api/review/models                      — локальные модели + окна контекста
GET  /api/review/audit?run_id=
GET  /api/review/stats?what=agents|replay&limit= — вклад ролей / пересчёт вердиктов (§17.5)
POST /api/review/sync                        {board?}
POST /api/review/prepare                     {card, profile, request}
POST /api/review/runs                        {card, profile, request, board?, force?}
POST /api/review/runs/<id>/cancel
POST /api/review/runs/<id>/transition        {approve, comment}
POST /api/review/profiles                    {id?, name, spec, is_default?}
POST /api/review/profiles/<id>/archive | /default
POST /api/review/agents                      {key, spec}
POST /api/review/agents/<key>/delete
POST /api/review/agents/reset
POST /api/review/boards                      {board, spec}
POST /api/review/settings                    {key, value}
"""
from __future__ import annotations

import review_catalog as cat
import review_service as svc
import tboards
from review_store import ReviewStore
from store import Store


def _tboards_state() -> dict:
    """Ключ продукта без сети и без самого ключа: есть ли, какой продукт, почему нет."""
    try:
        key = tboards.load_key()
        return {"ok": True, "product": key["name"] or key["slug"], "url": key["url"]}
    except tboards.TBoardsError as exc:
        return {"ok": False, "error": str(exc)}


def _int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class ReviewApi:
    def __init__(self, cfg, db_path: str | None = None):
        self.cfg = cfg
        self.db_path = db_path

    def _rs(self) -> tuple[Store, ReviewStore]:
        store = Store(self.db_path) if self.db_path else Store()
        return store, ReviewStore(store)

    # ── GET ─────────────────────────────────────────────────────────────────
    def get(self, route: str, one) -> dict:
        store, rs = self._rs()
        try:
            if route == "/api/review/state":
                return self.state(rs)
            if route == "/api/review/queue":
                return {"cards": [_card_view(c) for c in rs.queue(one("board"), one("left") == "1")]}
            if route == "/api/review/runs":
                return {"runs": rs.runs(one("card_id"), one("status"), _int(one("limit", "50"), 50))}
            if route.startswith("/api/review/runs/"):
                run = rs.run(route.rsplit("/", 1)[-1])
                if not run:
                    return {"error": "прогон не найден"}
                return {"run": run, "steps": rs.steps(run["id"]), "audit": rs.audit_log(run["id"]),
                        "card": _card_view(rs.card(run["card_id"]) or {})}
            if route.startswith("/api/review/steps/"):
                return {"step": rs.step(_int(route.rsplit("/", 1)[-1], 0))}
            if route == "/api/review/statuses":
                board = one("board") or "tasks"
                if board not in cat.BOARDS:
                    return {"error": "доска: bugs | tasks"}
                names, source = svc.board_statuses(self.cfg, board)
                return {"board": board, "statuses": names, "source": source}
            if route.startswith("/api/review/profiles/") and route.endswith("/versions"):
                return {"versions": rs.profile_versions(route.split("/")[4])}
            if route == "/api/review/models":
                return self.models()
            if route == "/api/review/audit":
                return {"audit": rs.audit_log(one("run_id"))}
            if route == "/api/review/stats":
                import review_stats
                if one("what") == "replay":
                    data = review_stats.replay(store, _int(one("limit", "0"), 0))
                    data.pop("rows", None)
                    return data
                return review_stats.agent_stats(store, _int(one("limit", "0"), 0))
            return {"error": "нет такого маршрута"}
        finally:
            store.close()

    def state(self, rs: ReviewStore) -> dict:
        queue = rs.queue()
        return {
            "settings": rs.settings(), "boards": rs.boards(), "profiles": rs.profiles(),
            "agents": rs.agents(), "counts": rs.counts(),
            "queue_size": len(queue),
            "queue_unreviewed": sum(1 for c in queue if not c.get("last_run")),
            "proposed": rs.s.q("SELECT id, card_title, transition_target FROM review_runs "
                               "WHERE transition_state = 'proposed' ORDER BY finished_at DESC LIMIT 50"),
            "catalog": {
                "methods": [{"key": k, "label": v["label"], "about": v["about"],
                             "stages": v["stages"], "custom": bool(v.get("custom"))}
                            for k, v in cat.METHODS.items()],
                "params": cat.PARAM_SPEC, "stage_types": cat.STAGE_TYPES, "flavors": cat.FLAVORS,
                "participant_modes": cat.PARTICIPANT_MODES, "kinds": cat.AGENT_KINDS,
                "default_rubric": cat.DEFAULT_RUBRIC, "default_tokens": cat.DEFAULT_TOKENS,
                "default_verdict": cat.DEFAULT_VERDICT, "verdicts": cat.VERDICTS,
                "default_consult": cat.DEFAULT_CONSULT, "consult_limits": cat.CONSULT_LIMITS,
            },
            "tboards": _tboards_state(),
        }

    def models(self) -> dict:
        import ollama as ollama_mod
        client = ollama_mod.build(self.cfg)
        alive = client.alive()
        local = []
        if alive:
            for name in sorted(client.installed_models()):
                local.append({"name": name, "context": client.context_length(name),
                              "large": self.cfg.is_large(name)})
        return {"alive": alive, "local": local, "cloud": sorted(svc.cloud_models(self.cfg)),
                "base_num_ctx": int(self.cfg.get("models.num_ctx", 8192))}

    # ── POST ────────────────────────────────────────────────────────────────
    def post(self, route: str, body: dict) -> dict:
        store, rs = self._rs()
        try:
            return self._post(rs, route, body)
        except cat.ValidationError as exc:
            return {"error": str(exc)}
        finally:
            store.close()

    def _post(self, rs: ReviewStore, route: str, body: dict) -> dict:
        if route == "/api/review/sync":
            board = body.get("board") or None
            stats = svc.sync_queue(self.cfg, rs, boards=[board] if board else None)
            return {"ok": not stats.get("partial"), "stats": stats, "error": stats.get("error")}
        if route == "/api/review/prepare":
            return svc.prepare(self.cfg, rs, str(body.get("card") or ""), str(body.get("profile") or ""),
                               body.get("request") or {}, live=body.get("live", True) is not False)
        if route == "/api/review/runs":
            return svc.enqueue(self.cfg, rs, str(body.get("card") or ""), str(body.get("profile") or ""),
                               "ui", body.get("request") or {}, board=str(body.get("board") or ""),
                               priority=_int(body.get("priority"), 6), force=bool(body.get("force")))
        if route.startswith("/api/review/runs/") and route.endswith("/cancel"):
            return {"ok": True, "state": rs.request_cancel(route.split("/")[4])}
        if route.startswith("/api/review/runs/") and route.endswith("/transition"):
            return svc.decide_transition(self.cfg, rs, route.split("/")[4], bool(body.get("approve")),
                                         "ui", str(body.get("comment") or ""))
        if route == "/api/review/profiles":
            prof = rs.save_profile(body.get("id") or None, str(body.get("name") or ""),
                                   body.get("spec") or {}, is_default=body.get("is_default") or None)
            return {"ok": True, "profile": prof}
        if route.startswith("/api/review/profiles/") and route.endswith("/archive"):
            rs.archive_profile(route.split("/")[4])
            return {"ok": True}
        if route.startswith("/api/review/profiles/") and route.endswith("/default"):
            rs.set_default_profile(route.split("/")[4])
            return {"ok": True}
        if route == "/api/review/agents":
            return {"ok": True, "agent": rs.save_agent(str(body.get("key") or ""), body.get("spec") or {})}
        if route == "/api/review/agents/reset":
            return {"ok": True, "reset": rs.reset_builtin_agents()}
        if route.startswith("/api/review/agents/") and route.endswith("/delete"):
            rs.delete_agent(route.split("/")[4])
            return {"ok": True}
        if route == "/api/review/boards":
            board = str(body.get("board") or "")
            if board not in cat.BOARDS:
                return {"error": "доска: bugs | tasks"}
            statuses, _src = svc.board_statuses(self.cfg, board)
            return {"ok": True, "board": rs.save_board(board, body.get("spec") or {}, statuses)}
        if route == "/api/review/settings":
            return {"ok": True, "settings": rs.set_setting(str(body.get("key") or ""), body.get("value"))}
        return {"error": "нет такого маршрута"}


def _card_view(card: dict) -> dict:
    if not card:
        return {}
    keep = ("card_id", "board", "title", "url", "status", "priority", "severity", "task_type",
            "backlog_id", "modules", "tags", "half_baked", "in_queue", "first_seen_at",
            "last_seen_at", "last_run", "report")
    out = {k: card.get(k) for k in keep}
    out["body_preview"] = (card.get("body") or "")[:600]
    return out
