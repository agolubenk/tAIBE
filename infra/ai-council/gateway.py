#!/usr/bin/env python3
"""AI Council — HTTP-шлюз и UI ревью. Только stdlib.

Канон: docs/specs/ai-council.md §3, §12 (фаза P3, «gateway.py + UI»).

    python3 infra/ai-council/gateway.py            # сервис (под супервизором)
    python3 infra/ai-council/gateway.py --port 8790

Зачем он есть. Результат прогона до сих пор жил в двух местах: в `council.db` (нужен
sqlite3 и знание схемы) и в Notion (там уже итог, а не то, КАК он получен). Вердикт —
единственный сигнал обучения (§9) — ставился командой `supervisor.py verdict --run …`,
для чего надо было сперва глазами найти run_id. Это и есть причина, по которой вердиктов
в базе ноль: цена ревью была выше ценности.

Три правила, из которых следует вся конструкция ниже:

1. **Только 127.0.0.1.** Здесь полный транскрипт прогонов и содержимое борда. Наружу это
   не выставляется, поэтому нет ни авторизации, ни CORS — вместо них отсутствие сокета
   на внешнем интерфейсе. Явная проверка host стоит в `serve()`.
2. **Читатель, а не второй писатель.** Шлюз читает `council.db` и пишет ровно три вещи:
   вердикт (`verdicts`), постановку в очередь (`runs`) и — с Ф1/P2 — черновик задачи
   с главной формы (`cards` с db='draft', заведён локально, никогда не существовал в
   Notion). В Notion не пишет никогда — это работа `emit.py`, у которой свои гварды и
   dry-run по умолчанию; `emit.py` черновики пропускает (нет page_id).
3. **Ноль внешних зависимостей и ноль сборки.** UI — один самодостаточный HTML-документ
   в этом же файле: ни npm, ни бандла, ни CDN. Подсистема должна подниматься на машине,
   где есть только Python — как и весь остальной консилиум.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import urllib.request                                    # noqa: E402

import config as config_mod                              # noqa: E402
import glm_mode                                          # noqa: E402
import graph_index as graph_index_mod                    # noqa: E402
import learning as learning_mod                          # noqa: E402
import queue_control                                     # noqa: E402
from review_api import ReviewApi                         # noqa: E402
from store import REPO_ROOT, Store, git_sha, sha16       # noqa: E402

UI_FILE = HERE / "ui" / "index.html"
# Скрипты вкладки «Ревью» — отдельными файлами (index.html и так 2.8k строк). Белый список:
# шлюз отдаёт только эти пути, а не произвольные файлы из ui/.
UI_SCRIPTS = {"/review.js": HERE / "ui" / "review.js",
              "/review-settings.js": HERE / "ui" / "review-settings.js",
              "/bindings.js": HERE / "ui" / "bindings.js"}
_stopping = threading.Event()


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def _escape_like(text: str) -> str:
    """`%`/`_` в тексте (обычные символы в заголовках вида `AI_COUNCIL_CLOUD`) — это
    LIKE-wildcard'ы для SQLite, а не литералы: без эскейпа `_` в упоминании матчит
    любой символ, что даёт ложную неоднозначность или тихую привязку к чужой карточке."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# ─────────────────────────────────────────────────────────────────────────────
# Слой данных. Каждый запрос берёт СВОЁ соединение: sqlite3-объекты привязаны к
# потоку-создателю, а сервер многопоточный. Одно общее соединение здесь означало бы
# ProgrammingError на втором параллельном запросе.
# ─────────────────────────────────────────────────────────────────────────────

# ── надёжность моделей по журналу вызовов (вкладка «Качество») ───────────────
# Один флаг `ok` из журнала смешивал три разных вопроса: дошла ли генерация (облако мог отказать
# квотой ещё до HTTP), разобрался ли ответ в нужную структуру, и сколько это стоит по времени.
# 13.10 нули glm-5.x (1017 + 762 + 339 вызовов) были целиком отказами недельной квоты 1310 —
# а таблица показывала их как «0 успешных» у модели. Теперь — раздельно и за период.
_CLOUD_REFUSAL_CLASSES = (
    # (класс, условие SQL над cloud_usage) — первое совпавшее; порядок важен. Строки пишет cloud.py:
    # квота подписки — HTTP 429 с кодом 1308/1310 (+ QUOTA_ERROR_MARK) или ожидание по общей отметке
    # (refused «квота подписки …»); всё прочее в refused — наши лимиты (окно плана, сутки, частота, прогон).
    ("quota", "error LIKE '%\"1308\"%' OR error LIKE '%\"1310\"%' OR error LIKE '%исчерпана квота%' "
              "OR refused LIKE 'квота подписки%'"),
    ("budget", "refused <> ''"),
    ("network", "error LIKE 'сеть/%' OR error LIKE '%timed out%' OR error LIKE '%таймаут%'"),
    ("provider", "error LIKE 'HTTP 429%' OR error LIKE 'HTTP 5%'"),
    ("unparsed", "error LIKE '%не распарсился%'"),
)


def model_reliability(store, days: int) -> dict:
    """Строки «модель/роль» за окно: попытки, успех, без ответа, не разобрано; время и токены — по успешным.

    «Без ответа» — генерации нет вовсе (отказ облака, таймаут, локальный слот занят); «не разобран» — текст
    пришёл, но не лёг в схему. Для облачных моделей — разбивка отказов по `cloud_usage` того же окна:
    квота и бюджет — не качество модели, их видно отдельно.
    """
    since = int(time.time()) - days * 86400 if days > 0 else 0
    rows = store.q(
        "SELECT model, role, COUNT(*) n, SUM(ok) ok, "
        "SUM(CASE WHEN ok = 0 AND length(COALESCE(response, '')) = 0 THEN 1 ELSE 0 END) no_answer, "
        "SUM(CASE WHEN ok = 0 AND length(COALESCE(response, '')) > 0 THEN 1 ELSE 0 END) unparsed, "
        "AVG(CASE WHEN ok = 1 THEN ms END) ms_ok, AVG(CASE WHEN ok = 1 THEN tokens_out END) tokens_ok, "
        "MAX(created_at) last_at "
        "FROM messages WHERE created_at >= ? GROUP BY model, role ORDER BY n DESC LIMIT 40", (since,))
    case = " ".join(f"WHEN {cond} THEN '{name}'" for name, cond in _CLOUD_REFUSAL_CLASSES)
    refusals = store.q(
        f"SELECT model, role, CASE {case} ELSE 'other' END kind, COUNT(*) n FROM cloud_usage "
        "WHERE ok = 0 AND created_at >= ? GROUP BY model, role, kind", (since,))
    by_pair: dict[tuple[str, str], dict[str, int]] = {}
    for r in refusals:
        by_pair.setdefault((r["model"], r["role"]), {})[r["kind"]] = r["n"]
    totals: dict[str, int] = {}
    for row in rows:
        refused = by_pair.pop((row["model"], row["role"]), {})
        row["cloud_refusals"] = refused
        # «Дошли до модели» — знаменатель успеха. Журналы разные (cloud_usage пишет и отказ без сообщения,
        # и повтор), поэтому вычитание зажато: не меньше успешных и не больше всех попыток.
        blocked = refused.get("quota", 0) + refused.get("budget", 0)
        row["reached"] = min(row["n"], max(row["ok"] or 0, row["n"] - blocked))
        for kind, n in refused.items():
            totals[kind] = totals.get(kind, 0) + n
    # Отказы ролей, которых нет в таблице (ревью, извлечение терминов, doctor, хвост за LIMIT) — одним числом,
    # чтобы итог над таблицей сходился с её колонкой.
    outside = sum(n for kinds in by_pair.values() for n in kinds.values())
    return {"rows": rows, "since": since, "cloud_refusals": totals, "cloud_refusals_outside": outside}


class Api:
    def __init__(self, cfg, db_path: str | None = None):
        self.cfg = cfg
        self.db_path = db_path

    def _store(self) -> Store:
        return Store(self.db_path) if self.db_path else Store()

    # ── сводка ───────────────────────────────────────────────────────────────
    def state(self) -> dict:
        with self._store() as store:
            depth = store.queue_depth()
            cards = store.q1("SELECT COUNT(*) n FROM cards") or {}
            bugs = store.q1("SELECT COUNT(*) n FROM cards WHERE db='bugs'") or {}
            half = store.q1("SELECT COUNT(*) n FROM cards WHERE half_baked=1") or {}
            lock = store.current_model_lock()
            verdicts = store.q1("SELECT COUNT(*) n FROM verdicts") or {}
            pending = store.q1(
                "SELECT COUNT(*) n FROM runs r WHERE r.status='done' "
                "AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.run_id = r.id)") or {}
            last_plan = store.q1(
                "SELECT id, window_from, window_to, created_at FROM plans "
                "ORDER BY created_at DESC LIMIT 1")
            return {
                "queue": depth,
                "cards": {"total": cards.get("n", 0), "bugs": bugs.get("n", 0),
                          "half_baked": half.get("n", 0)},
                "model_lock": lock,
                # Пауза очереди и профили, заблокированные memory-guard: шапка и «Обзор»
                # показывают, почему очередь стоит, без отдельного запроса.
                "queue_ctl": {"paused": queue_control.is_paused(store),
                              "memory_blocked": queue_control.get_state(store, "memory.blocked", {}) or {},
                              "escalation": queue_control.escalation_status(
                                  store, int(self.cfg.get("models.cloud_escalation.after_seconds", 7200)),
                                  bool(self.cfg.get("models.cloud_escalation.enabled", False))
                                  and self.cfg.cloud_enabled())},
                "verdicts": {"total": verdicts.get("n", 0),
                             "awaiting_review": pending.get("n", 0)},
                "last_plan": last_plan,
                "services": self.services(),
                "cloud": self.cloud(),
                "git": git_sha(),
                "profile": self.cfg.get("models.profile", "fast"),
                "config_hash": self.cfg.config_hash(),
            }

    def services(self) -> list[dict]:
        """Живость сервисов по их PID-файлам — тем же способом, что и supervisor.status,
        но без импорта супервизора: шлюз не должен уметь их останавливать."""
        state_dir = REPO_ROOT / ".claude/council"
        names = self.cfg.get("supervisor.services", []) or []
        out = []
        for name in list(names) + ["supervisor"]:
            pid_file = state_dir / f"{name}.pid"
            alive, pid = False, None
            if pid_file.is_file():
                try:
                    pid = int(pid_file.read_text().strip())
                    os.kill(pid, 0)
                    alive = True
                except (OSError, ValueError):
                    alive = False
            out.append({"name": name, "alive": alive, "pid": pid})
        return out

    def cloud(self) -> dict:
        """Бюджет подписки. Считается по cloud_usage — тому же источнику, что и стопы
        в cloud.py, поэтому цифра в UI и цифра, по которой отказывают вызовы, — одна."""
        import cloud as cloud_mod
        with self._store() as store:
            client = cloud_mod.build(self.cfg, store)
            # Тумблер «всё на GLM 5.x» (§17.6): пока он действует, окно и сутки — лимиты режима,
            # и шапка обязана показывать ту же цифру, по которой воркер отказывает вызовам.
            glm = glm_mode.status(store, self.cfg)
            glm_mode.apply_budget(client, self.cfg, glm["effective"])
            window = client.spent_in_window()
            day = client.spent_today()
            budget = client.budget
            recent = store.q(
                "SELECT created_at, run_id, role, model, tokens_in, tokens_out, usd, ok, "
                "refused, error FROM cloud_usage ORDER BY id DESC LIMIT 20")
            return {
                "enabled": budget.enabled,
                "window": {"calls": window["calls"], "max": budget.max_calls_per_window,
                           "hours": budget.window_hours},
                "day": {"calls": day["calls"], "max_calls": budget.max_calls_per_day,
                        "tokens": day["tokens"], "usd": round(day["usd"], 4),
                        "max_usd": budget.max_usd_per_day},
                "ladder": self.cfg.get("models.cloud.roles.ladder", []) or [],
                "per_profile": budget.max_calls_per_run_by_profile,
                # Контуры биллинга по провайдерам. У Z.AI их два, и расход по ним считается
                # раздельно: подписку держит окно вызовов, платный General API — свой
                # суточный потолок вызовов И денег. Одной строкой «облако» это не описать.
                "contours": {name: client.contours_of(name)
                             for name in sorted(client.providers)},
                "recent": recent,
                "glm": glm,
            }

    def glm(self) -> dict:
        with self._store() as store:
            return glm_mode.status(store, self.cfg)

    def set_glm(self, on: bool) -> dict:
        """Тумблер шапки. Воркер читает флаг на каждом захвате — рестарт не нужен. Включить
        при выключенном облаке нельзя: режим, который молча идёт локально, — обман шапки."""
        if on and not self.cfg.cloud_enabled():
            return {"ok": False, "error": "режим GLM 5.x требует облака — сначала включите облако "
                                          "(Обзор → «Облако — состояние»)"}
        with self._store() as store:
            glm_mode.set_on(store, bool(on), "ui")
            state = glm_mode.status(store, self.cfg)
        log(f"режим GLM 5.x {'включён' if on else 'выключен'}")
        return {"ok": True, **state}

    def _cloud_mode(self, raw) -> tuple[str, str]:
        """Отметка задачи «GLM 5.x» из запроса → ('glm5' | '', ошибка)."""
        mode = str(raw or "").strip()
        if not mode:
            return "", ""
        if mode != glm_mode.CLOUD_MODE:
            return "", f"cloud_mode: допустимо только `{glm_mode.CLOUD_MODE}` (все роли на GLM 5.x)"
        if not self.cfg.cloud_enabled():
            return "", ("режим GLM 5.x требует облака: models.cloud.enabled=true — локально "
                        "задача с этой отметкой не подменяется")
        return mode, ""

    def cloud_ping(self, provider: str, contour: str) -> dict:
        """Живая проверка одного контура. Это настоящий вызов: на подписке он тратит
        обращение из окна, на General API — деньги, поэтому UI обязан предупредить, а
        результат попадает в тот же журнал, что и рабочие вызовы."""
        import cloud as cloud_mod
        with self._store() as store:
            client = cloud_mod.build(self.cfg, store)
            node = client.providers.get(provider) or {}
            models = node.get("models") or []
            if not models:
                return {"ok": False, "error": f"у провайдера `{provider}` нет моделей"}
            if contour not in {"primary", "fallback"}:
                return {"ok": False, "error": f"неизвестный контур `{contour}`"}
            # Первая ступень лестницы: проверять связь самой дорогой моделью незачем.
            ladder = [m for m in (self.cfg.get("models.cloud.roles.ladder") or [])
                      if m in models]
            model = ladder[0] if ladder else models[0]
            ok, detail = client.ping(model, contour=contour)
            return {"ok": ok, "provider": provider, "contour": contour,
                    "model": model, "detail": detail}

    # ── прогоны ──────────────────────────────────────────────────────────────
    def runs(self, status: str = "", card_id: str = "", limit: int = 100) -> list[dict]:
        clauses, params = [], []
        if status:
            clauses.append("r.status = ?")
            params.append(status)
        if card_id:
            # MCP `council_card_runs` (план §P4) принимает и внутренний card_id, и
            # человекочитаемый backlog_id (B-24/TAI-3) — внешний агент не обязан
            # знать внутренний id, у него есть только то, что видно в Notion/чате.
            clauses.append("(r.card_id = ? OR c.backlog_id = ?)")
            params.extend([card_id, card_id])
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._store() as store:
            return store.q(
                "SELECT r.id, r.card_id, r.profile, r.track, r.status, r.outcome, "
                "r.confidence, r.readiness, r.started_at, r.finished_at, r.wall_ms, r.error, "
                "r.escalation, r.mem_wait_since, r.cloud_retry_at, r.cloud_mode, "
                "c.title, c.db, c.priority, c.severity, c.url, c.half_baked, c.backlog_id, "
                "(SELECT decision FROM verdicts v WHERE v.run_id = r.id "
                " ORDER BY v.id DESC LIMIT 1) verdict "
                f"FROM runs r LEFT JOIN cards c ON c.card_id = r.card_id {where} "
                "ORDER BY COALESCE(r.finished_at, r.started_at, 0) DESC, r.rowid DESC "
                "LIMIT ?", tuple(params) + (min(limit, 500),))

    def run_detail(self, run_id: str) -> dict:
        with self._store() as store:
            run = store.q1(
                "SELECT r.*, c.title, c.db, c.url, c.priority, c.severity, c.body, "
                "c.half_baked, c.backlog_id FROM runs r LEFT JOIN cards c "
                "ON c.card_id = r.card_id WHERE r.id = ?", (run_id,))
            if not run:
                return {}
            run["payload"] = _loads(run.get("payload"))
            proposals = store.q(
                "SELECT id, role, model, payload, grounded_score, review_score, total_score "
                "FROM proposals WHERE run_id = ? ORDER BY id", (run_id,))
            for p in proposals:
                p["payload"] = _loads(p.get("payload"))
            reviews = store.q(
                "SELECT reviewer_model, reviewer_role, target_proposal, scores, objections "
                "FROM reviews WHERE run_id = ? ORDER BY id", (run_id,))
            for r in reviews:
                r["scores"] = _loads(r.get("scores"))
                r["objections"] = _loads(r.get("objections")) or []
            verifications = store.q(
                "SELECT proposal_id, checked, hallucinations, passed FROM verifications "
                "WHERE run_id = ? ORDER BY id", (run_id,))
            for v in verifications:
                v["checked"] = _loads(v.get("checked")) or []
                v["hallucinations"] = _loads(v.get("hallucinations")) or []
            # Транскрипт может быть в мегабайтах (промпт целиком на каждый вызов).
            # В список отдаём метаданные, тело — отдельным запросом по id.
            messages = store.q(
                "SELECT id, round, role, model, ok, tokens_in, tokens_out, ms, created_at, "
                "LENGTH(prompt) prompt_len, LENGTH(response) response_len "
                "FROM messages WHERE run_id = ? ORDER BY id", (run_id,))
            verdicts = store.q(
                "SELECT id, decision, comment, created_at FROM verdicts WHERE run_id = ? "
                "ORDER BY id DESC", (run_id,))
            cloud_calls = store.q(
                "SELECT role, model, tokens_in, tokens_out, usd, ms, ok, refused, error, "
                "created_at FROM cloud_usage WHERE run_id = ? ORDER BY id", (run_id,))
            return {"run": run, "proposals": proposals, "reviews": reviews,
                    "verifications": verifications, "messages": messages,
                    "verdicts": verdicts, "cloud": cloud_calls}

    def message(self, message_id: int) -> dict:
        with self._store() as store:
            return store.q1(
                "SELECT id, run_id, round, role, model, prompt, response, ok, ms, "
                "tokens_in, tokens_out FROM messages WHERE id = ?", (message_id,)) or {}

    # ── карточки ─────────────────────────────────────────────────────────────
    def cards(self, db: str = "", query: str = "", limit: int = 200) -> list[dict]:
        clauses, params = [], []
        if db:
            clauses.append("db = ?")
            params.append(db)
        if query:
            clauses.append("(title LIKE ? ESCAPE '\\' OR backlog_id LIKE ? ESCAPE '\\')")
            like = f"%{_escape_like(query)}%"
            params += [like, like]
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._store() as store:
            return store.q(
                "SELECT card_id, db, title, url, status, priority, severity, modules, "
                "half_baked, backlog_id, "
                "(SELECT COUNT(*) FROM runs r WHERE r.card_id = cards.card_id) runs, "
                "(SELECT r.readiness FROM runs r WHERE r.card_id = cards.card_id "
                " AND r.status='done' ORDER BY r.finished_at DESC LIMIT 1) readiness, "
                "(SELECT n.note FROM card_notes n WHERE n.card_id = cards.card_id "
                " AND n.active = 1 ORDER BY n.id DESC LIMIT 1) note "
                f"FROM cards {where} ORDER BY half_baked, priority, title LIMIT ?",
                tuple(params) + (min(limit, 500),))

    def cards_autocomplete(self, query: str = "", limit: int = 8) -> list[dict]:
        """@-упоминания на главной форме (Ф1/P2). Набор идёт на каждое нажатие клавиши —
        без подзапросов runs/readiness/notes из cards(), которые здесь не нужны и только
        замедлили бы дропдаун."""
        clauses, params = [], []
        if query:
            clauses.append("(title LIKE ? ESCAPE '\\' OR backlog_id LIKE ? ESCAPE '\\')")
            like = f"%{_escape_like(query)}%"
            params += [like, like]
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._store() as store:
            return store.q(
                "SELECT card_id, db, title, backlog_id, half_baked "
                f"FROM cards {where} ORDER BY half_baked, title LIMIT ?",
                tuple(params) + (min(limit, 20),))

    def plan(self) -> dict:
        with self._store() as store:
            row = store.q1("SELECT * FROM plans ORDER BY created_at DESC LIMIT 1")
            if not row:
                return {}
            row["items"] = _loads(row.get("items")) or []
            return row

    # ── запись: ровно три операции (см. правило 2 в docstring модуля) ─────────
    def verdict(self, run_id: str, decision: str, comment: str) -> dict:
        if decision not in ("accept", "edit", "reject"):
            return {"ok": False, "error": f"неизвестное решение `{decision}`"}
        with self._store() as store:
            if not store.q1("SELECT id FROM runs WHERE id = ?", (run_id,)):
                return {"ok": False, "error": f"прогон {run_id} не найден"}
            store.x("INSERT INTO verdicts (run_id, decision, comment, created_at) "
                    "VALUES (?,?,?,?)", (run_id, decision, comment or "", int(time.time())))
            store.event("verdict", run_id, decision)
            # §9: вес обновляется мгновенно, а не к следующему циклу сервиса обучения.
            # Вердикт — единственный сигнал владельца, и он должен действовать сразу,
            # иначе следующий прогон, запущенный через минуту, о нём не знает.
            learned = learning_mod.apply_run(store, run_id)
        log(f"вердикт {decision} для {run_id}")
        return {"ok": True, "learning": learned}

    def enqueue(self, card_id: str, profile: str, priority: int = 9, cloud_mode: str = "") -> dict:
        allowed = ("fast", "deep", "hybrid", "cloud")
        if profile not in allowed:
            return {"ok": False, "error": f"профиль должен быть одним из {allowed}"}
        cloud_mode, why = self._cloud_mode(cloud_mode)
        if why:
            return {"ok": False, "error": why}
        # Тот же гвард, что в supervisor.cmd_run: очередь из облачных прогонов при
        # выключенном облаке — это очередь гарантированных воздержаний.
        if profile in ("hybrid", "cloud") and not self.cfg.cloud_enabled():
            return {"ok": False,
                    "error": f"профиль `{profile}` требует облака: AI_COUNCIL_CLOUD=1 "
                             f"или models.cloud.enabled=true"}
        with self._store() as store:
            card = store.get_card(card_id)
            if not card:
                return {"ok": False, "error": f"карточка {card_id} не в снапшоте"}
            run_id = store.enqueue(
                card_id, track="half_baked" if card["half_baked"] else "elaborate",
                profile=profile, priority=priority, config_hash=self.cfg.config_hash(),
                git_sha=git_sha(), card_hash=card.get("content_hash") or "", dedupe=False,
                cloud_mode=cloud_mode)
        log(f"поставлен в очередь {run_id} ({profile}{', GLM 5.x' if cloud_mode else ''}) — "
            f"{card['title'][:60]}")
        return {"ok": True, "run_id": run_id, "cloud_mode": cloud_mode}

    def create_task(self, title: str, body: str, links: list[str], profile: str,
                    cloud_mode: str = "") -> dict:
        cloud_mode, why = self._cloud_mode(cloud_mode)
        if why:
            return {"ok": False, "error": why}
        return self._create_task(title, body, links, profile, cloud_mode)

    def _create_task(self, title: str, body: str, links: list[str], profile: str,
                     cloud_mode: str = "") -> dict:
        """Главная форма (Ф1/P2): черновик — ЛОКАЛЬНАЯ карточка (db='draft'), Notion не
        трогает вообще (см. docstring модуля — третье, документированное исключение из
        «шлюз пишет ровно две вещи»). @-упоминания резолвит сервер (точное совпадение
        title → LIKE-фолбэк с эскейпом `%`/`_` → неразрешённые — явная ошибка), а не
        клиент: `links` — это ТОЛЬКО чипы (выбор из дропдауна автокомплита), UI не
        разбирает произвольный текст `@[...]`, набранный руками мимо дропдауна."""
        title = (title or "").strip()
        body = (body or "").strip()
        links = links or []
        if not title or len(title) > 1900:
            return {"ok": False, "error": "заголовок должен быть 1..1900 символов"}
        if len(body) > 8000:
            return {"ok": False, "error": "текст задачи не может быть длиннее 8000 символов"}
        if len(links) > 5:
            return {"ok": False, "error": "не более 5 связанных карточек"}
        allowed = ("fast", "deep", "hybrid", "cloud")
        if profile not in allowed:
            return {"ok": False, "error": f"профиль должен быть одним из {allowed}"}
        if profile in ("hybrid", "cloud") and not self.cfg.cloud_enabled():
            return {"ok": False,
                    "error": f"профиль `{profile}` требует облака: AI_COUNCIL_CLOUD=1 "
                             f"или models.cloud.enabled=true"}

        ts = time.time()
        content_hash = sha16(title + body)
        with self._store() as store:
            # BEGIN IMMEDIATE держит анти-спам SELECT и запись одной атомарной операцией
            # (тот же паттерн, что claim_run() в store.py) — иначе два почти одновременных
            # POST (двойной клик, ретрай сети) оба видят пустой SELECT и оба проходят,
            # каждый на своём соединении (по потоку на HTTP-запрос).
            store.conn.execute("BEGIN IMMEDIATE")
            try:
                dupe = store.q1(
                    "SELECT card_id FROM cards WHERE db='draft' AND content_hash = ? "
                    "AND fetched_at > ? ORDER BY fetched_at DESC LIMIT 1",
                    (content_hash, int(ts) - 10))
                if dupe:
                    store.conn.execute("COMMIT")
                    return {"ok": False, "error": "эта задача уже отправлена — подождите"}

                linked_ids: list[str] = []
                unresolved: list[str] = []
                for raw in links:
                    mention = str(raw or "").strip()
                    if not mention:
                        continue
                    exact = store.q1("SELECT card_id FROM cards WHERE title = ? LIMIT 1",
                                      (mention,))
                    if exact:
                        linked_ids.append(exact["card_id"])
                        continue
                    like = store.q(
                        "SELECT card_id FROM cards WHERE title LIKE ? ESCAPE '\\' LIMIT 2",
                        (f"%{_escape_like(mention)}%",))
                    if len(like) == 1:
                        linked_ids.append(like[0]["card_id"])
                    else:
                        unresolved.append(mention)
                if unresolved:
                    store.conn.execute("COMMIT")
                    return {"ok": False,
                            "error": f"не найдены/неоднозначны упоминания: {', '.join(unresolved)}"}
                # находка N1 (review-p2.md, 3й проход): прямой вызов API мимо клиентского
                # dedup в pickMention() мог повторить один card_id — дедуп с сохранением
                # порядка у источника, не в трёх местах retrieval.py, которые это читают.
                linked_ids = list(dict.fromkeys(linked_ids))

                card_id = "draft_" + sha16(f"{title}{ts}")
                store.upsert_card({
                    "card_id": card_id, "db": "draft", "title": title, "url": "",
                    "status": "черновик", "priority": None, "severity": None,
                    "task_type": None, "source": "home-form", "backlog_id": None,
                    "modules": "[]", "tags": "[]", "half_baked": 0, "parent_card_id": None,
                    "subtask_ids": "[]", "report": None, "body": body, "comments": "[]",
                    "content_hash": content_hash, "notion_edited_at": None,
                    "fetched_at": int(ts), "linked_card_ids": json.dumps(linked_ids),
                })
                run_id = store.enqueue(
                    card_id, track="elaborate", profile=profile, priority=9,
                    config_hash=self.cfg.config_hash(), git_sha=git_sha(),
                    card_hash=content_hash, dedupe=False, cloud_mode=cloud_mode)
                store.conn.execute("COMMIT")
            except sqlite3.Error:
                try:
                    store.conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
        log(f"черновик {card_id} с главной формы, поставлен в очередь {run_id} ({profile}"
            f"{', GLM 5.x' if cloud_mode else ''})")
        return {"ok": True, "card_id": card_id, "run_id": run_id, "cloud_mode": cloud_mode}

    # ── модели и роли ────────────────────────────────────────────────────────
    def models(self) -> dict:
        """Полный ростер: что установлено локально, что доступно в облаке, кто в каких
        ролях. Локальные модели бесплатны и безлимитны, облачные тратят квоту — в UI
        это должно быть видно до запуска, а не после."""
        import ollama as ollama_mod
        client = ollama_mod.build(self.cfg)
        installed, alive = [], client.alive()
        if alive:
            try:
                installed = sorted(client.installed_models())
            except Exception:                                   # noqa: BLE001
                installed = []
        large = self.cfg.large_models()

        cloud_models: dict[str, str] = {}
        for provider, node in (self.cfg.get("models.cloud.providers", {}) or {}).items():
            for name in (node.get("models") or []):
                cloud_models[name] = provider

        profiles: dict[str, dict] = {}
        for profile in ("fast", "deep", "hybrid", "cloud"):
            try:
                roster = self.cfg.roles(profile)
            except Exception:                                   # noqa: BLE001
                continue
            profiles[profile] = {
                "roles": roster,
                "uses_cloud": sorted({m for m in roster.values() if m in cloud_models}),
                "missing": sorted({m for m in roster.values()
                                   if m not in installed and m not in cloud_models}),
            }

        catalogue = []
        for name in installed:
            catalogue.append({"name": name, "tier": "local",
                              "size_gb": large.get(name), "free": True,
                              "resident_exclusive": name in large})
        for name, provider in sorted(cloud_models.items()):
            catalogue.append({"name": name, "tier": "cloud", "provider": provider,
                              "free": False, "size_gb": None,
                              "resident_exclusive": False})
        with self._store() as store:
            glm = glm_mode.status(store, self.cfg)   # опция «GLM 5.x» в диалогах запуска
        return {"ollama_alive": alive, "ollama_url": client.base_url,
                "models": catalogue, "profiles": profiles,
                "cloud_enabled": self.cfg.cloud_enabled(),
                "default_profile": self.cfg.get("models.profile", "fast"),
                "glm": glm}

    # ── настройки ────────────────────────────────────────────────────────────
    # Правится не весь конфиг: config.toml — файл владельца с комментариями, которые
    # объясняют КАЖДОЕ значение (почему 900 с, почему 16000 токенов). Полная перезапись
    # из UI стёрла бы их, превратив обоснованный конфиг в голые числа. Поэтому UI меняет
    # только те скалярные ключи, что перечислены здесь, и правит их построчно.
    # (группа, подпись, тип, варианты) — группа определяет вкладку настроек в UI.
    EDITABLE = {
        # ── Консилиум: пороги, от которых зависит, будет ли результат ────────
        "models.profile": ("council", "Профиль по умолчанию", "choice",
                           ["adaptive", "fast", "deep", "hybrid", "cloud"]),
        "council.abstain_threshold": ("council", "Порог воздержания (из 15)", "int", None),
        "council.max_hallucinations": ("council", "Порог выдумок", "int", None),
        "council.scope_agreement_min": ("council", "Мин. согласие по файлам", "float", None),
        "council.max_wall_seconds_per_card": ("council", "Бюджет времени на карточку, с",
                                              "int", None),
        # ── Облако и бюджет подписки ────────────────────────────────────────
        "models.cloud.enabled": ("cloud", "Облако включено", "bool", None),
        "models.cloud.budget.max_calls_per_window": ("cloud", "Вызовов за окно", "int", None),
        "models.cloud.budget.window_hours": ("cloud", "Длина окна, ч", "int", None),
        "models.cloud.budget.max_calls_per_day": ("cloud", "Вызовов за сутки", "int", None),
        "models.cloud.budget.max_tokens_out": ("cloud", "Токенов на ответ", "int", None),
        "models.cloud.budget.max_usd_per_day": ("cloud", "Потолок $/сутки (вне подписки)",
                                                "float", None),
        "models.cloud.roles.judge": ("cloud", "Ступень арбитража по умолчанию", "choice",
                                     ["glm-4.6", "glm-4.7", "glm-5", "glm-5.2"]),
        # Облачная эскалация (§17.4): задачи, ждущие памяти дольше порога, — в облако.
        "models.cloud_escalation.enabled": ("cloud", "Эскалация в облако задач, ждущих памяти",
                                            "bool", None),
        "models.cloud_escalation.after_seconds": ("cloud", "Эскалация: ждать памяти, с (7200 = 2 ч)",
                                                  "int", None),
        "models.cloud.budget.max_calls_per_run_by_profile.escalation": (
            "cloud", "Эскалация: потолок облачных вызовов на прогон", "int", None),
        "models.cloud_escalation.quota_margin_seconds": (
            "cloud", "Эскалация: запас после сброса квоты, с", "int", None),
        "models.cloud_escalation.overload_retry_seconds": (
            "cloud", "Эскалация: повтор при перегрузке провайдера, с", "int", None),
        # Режим «всё на GLM 5.x» (§17.6): лимиты, пока режим включён в шапке или идёт
        # отмеченная им задача. Сам тумблер — в шапке, без рестарта; эти числа воркер
        # читает при старте.
        "models.glm_all.max_calls_per_window": ("cloud", "GLM 5.x: вызовов за окно", "int", None),
        "models.glm_all.window_hours": ("cloud", "GLM 5.x: длина окна, ч", "int", None),
        "models.glm_all.max_calls_per_day": ("cloud", "GLM 5.x: вызовов за сутки (≥ окна)",
                                             "int", None),
        "models.glm_all.max_calls_per_run": ("cloud", "GLM 5.x: потолок вызовов на прогон",
                                             "int", None),
        # ── API: адреса и таймауты. Ключи здесь НЕ хранятся и не правятся ────
        "models.ollama_url": ("api", "Ollama — адрес", "str", None),
        "models.request_timeout_seconds": ("api", "Ollama — таймаут, с", "int", None),
        "models.cloud.headroom.enabled": ("api", "Пускать облако через Headroom",
                                          "bool", None),
        "models.cloud.headroom.url": ("api", "Headroom — адрес прокси", "str", None),
        "models.cloud.providers.zai.base_url": ("api", "Z.AI — base URL", "str", None),
        "models.cloud.providers.zai.timeout_seconds": ("api", "Z.AI — таймаут, с", "int", None),
        "models.cloud.providers.gemini.base_url": ("api", "Gemini — base URL", "str", None),
        "models.cloud.request_timeout_seconds": ("api", "Облако — общий таймаут, с",
                                                 "int", None),
        "sources.notion.poll_interval_min": ("api", "Notion — период опроса, мин", "int", None),
        "sources.notion.rate_limit_rps": ("api", "Notion — запросов в секунду", "int", None),
        "gateway.port": ("api", "Порт этого шлюза", "int", None),
        # ── Что консилиум пишет обратно в борд ──────────────────────────────
        "outputs.notion_writeback.elaboration_block": ("outputs", "Писать блок проработки",
                                                       "bool", None),
        "outputs.notion_writeback.comments": ("outputs", "Писать комментарии", "bool", None),
        "outputs.notion_writeback.council_readiness": ("outputs", "Писать readiness",
                                                       "bool", None),
        "outputs.notion_writeback.priority": ("outputs", "Писать приоритет/severity",
                                              "bool", None),
        "outputs.notion_writeback.tags": ("outputs", "Писать теги", "bool", None),
    }

    GROUP_TITLES = {
        "council": "Консилиум — пороги качества",
        "cloud": "Облако и бюджет подписки",
        "api": "API — адреса, таймауты, ключи",
        "outputs": "Запись в Notion",
    }

    def settings(self) -> dict:
        groups: dict[str, list] = {}
        for key, (group, label, kind, choices) in self.EDITABLE.items():
            groups.setdefault(group, []).append(
                {"key": key, "label": label, "type": kind,
                 "choices": choices, "value": self.cfg.get(key)})
        # Источники знаний — тем же обходом, что и индексация (`~`, исключения, claude-mem),
        # плюс сколько документов каждого вида уже в корпусе (2026-10-09, §6).
        import knowledge_sources
        with self._store() as store:
            sources = knowledge_sources.source_listing(self.cfg, store)
        return {"groups": groups, "group_titles": self.GROUP_TITLES,
                "knowledge_sources": sources,
                "api": self.api_status(),
                "config_path": "infra/ai-council/config.toml",
                "config_hash": self.cfg.config_hash(),
                "writeback": self.cfg.get("outputs.notion_writeback", {}) or {}}

    # ── «с чего начать» ──────────────────────────────────────────────────────
    def setup(self) -> dict:
        """Пошаговый чек-лист готовности: что уже работает, что нет и чем это чинится.

        Причина, по которой он есть: подсистема из пяти демонов, двух ключей, борда,
        индекса и графа не объясняется интерфейсом сама. Каждый пункт отвечает на три
        вопроса сразу — «сделано ли», «что это вообще» и «какая кнопка это чинит», —
        иначе настройка требует чтения спеки, а работа — знания, в каком порядке жать.
        """
        import cloud as cloud_mod
        import ollama as ollama_mod

        services = {s["name"]: s["alive"] for s in self.services()}
        dead = [name for name, alive in services.items() if not alive]
        with self._store() as store:
            cards = (store.q1("SELECT COUNT(*) n FROM cards") or {}).get("n", 0)
            docs = (store.q1("SELECT COUNT(*) n FROM corpus_meta") or {}).get("n", 0)
            done = (store.q1("SELECT COUNT(*) n FROM runs WHERE status='done'") or {}).get("n", 0)
            awaiting = (store.q1(
                "SELECT COUNT(*) n FROM runs r WHERE r.status='done' AND NOT EXISTS "
                "(SELECT 1 FROM verdicts v WHERE v.run_id = r.id)") or {}).get("n", 0)
            verdicts = (store.q1("SELECT COUNT(*) n FROM verdicts") or {}).get("n", 0)
            plan = store.q1("SELECT id, created_at FROM plans ORDER BY created_at DESC LIMIT 1")

        ollama = ollama_mod.build(self.cfg)
        # Со store: расход по платному контуру считается по журналу вызовов, и без него
        # чек-лист показывал бы «израсходовано 0» независимо от того, сколько потрачено.
        with self._store() as store:
            cloud_client = cloud_mod.build(self.cfg, store)
            zai = cloud_client.providers.get("zai") or {}
            fallback = zai.get("fallback") or {}
            fallback_spent = cloud_client.fallback_spent_today("zai")
        graph_file = self.cfg.path_of("sources.graph.path")

        def item(key, title, ok, detail, fix="", op="", tab="", level="") -> dict:
            return {"key": key, "title": title, "ok": bool(ok), "detail": detail,
                    "fix": fix, "op": op, "tab": tab,
                    "level": level or ("ok" if ok else "todo")}

        steps = [
            item("services", "Сервисы подняты", not dead,
                 "работают: " + ", ".join(n for n, a in services.items() if a)
                 + (f"; стоят: {', '.join(dead)}" if dead else ""),
                 "запустить: npm run ai-council:start", op="council_start"),
            item("notion", "Борд Notion синхронизирован", cards > 0,
                 f"карточек в снимке: {cards}" if cards else "снимок борда пуст",
                 "ключ Notion — .claude/council/.notion-key, затем «Синхронизировать борд»",
                 op="sync"),
            item("ollama", "Локальные модели отвечают", ollama.alive(),
                 f"Ollama: {ollama.base_url}",
                 "поднять Ollama: ollama serve (модели — models.roles в config.toml)"),
            item("knowledge", "База знаний проиндексирована", docs > 0,
                 f"документов: {docs}", "операция «Переиндексировать базу знаний»",
                 op="reindex"),
            item("graph", "Граф проекта собран", graph_file.is_file(),
                 str(graph_file) if graph_file.is_file() else "graphify-out/graph.json нет",
                 "операция «Собрать граф» (AST, без вызовов моделей)", op="graph"),
            item("cloud", "Облако GLM подключено — оба контура",
                 bool(zai.get("key")) or bool(fallback.get("key")),
                 ("подписка Coding Plan: " + ("ключ есть" if zai.get("key") else "ключа нет")
                  + " · General API (платный): "
                  + ("ключ есть" if fallback.get("key") else "ключа нет")
                  + (f" (потолок {fallback.get('max_calls_per_day', 0)} вызовов и "
                     f"${fallback.get('max_usd_per_day', 0)} в сутки; израсходовано "
                     f"{fallback_spent['calls']} и ${fallback_spent['usd']:.4f})"
                     if fallback else "")),
                 "ключ подписки — ZAI_API_KEY, платный General API — ZAI_GENERAL_API_KEY "
                 "(.continue/.env либо .claude/council/.zai-general-key). Связь по каждому "
                 "контуру проверяется отдельно: страница «Облако» (таблетка облака в шапке) "
                 "→ «Проверить связь»",
                 tab="cloud",
                 level=("ok" if zai.get("key") and fallback.get("key")
                        else "warn" if zai.get("key") or fallback.get("key") else "todo")),
            item("run", "Есть хотя бы одна проработка", done > 0,
                 f"успешных прогонов: {done}",
                 "вкладка «Карточки» → «Запустить» на любой карточке без half-baked",
                 tab="cards"),
            item("verdict", "Вердикты поставлены", verdicts > 0 and awaiting == 0,
                 f"вердиктов: {verdicts}, ждут ревью: {awaiting}",
                 "«лента» (таблетка справа в шапке) → принять/поправить/отклонить: это единственный "
                 "сигнал обучения (§9)", tab="feed",
                 level="ok" if verdicts and not awaiting else "warn" if verdicts else "todo"),
            item("plan", "План на день собран", bool(plan),
                 (f"последний план {plan['id']} от "
                  + time.strftime("%d.%m %H:%M", time.localtime(plan["created_at"])))
                 if plan else "планов ещё не было",
                 "планировщик пересобирает план сам каждые "
                 f"{self.cfg.get('planner.rebuild_minutes', 30)} мин; в файлы — операция "
                 "«Собрать план и записать»", op="plan"),
        ]
        ready = sum(1 for s in steps if s["ok"])
        return {"steps": steps, "ready": ready, "total": len(steps)}

    # ── «как это работает» ───────────────────────────────────────────────────
    # Пояснения к вкладкам: что это и что здесь делать. Живут на сервере, а не в
    # разметке, потому что половина из них зависит от конфига (интервалы, потолки,
    # права записи), а прописанная в HTML прозаическая копия конфига разъезжается с ним
    # молча — и тогда интерфейс объясняет не то, что происходит.
    # Имена вкладок — как в TABS у ui/index.html (объединение вкладок 2026-08-21:
    # обзор+управление, качество+обучение, прогоны+лента, знания+граф; прежние
    # имена клиент резолвит алиасами, но канонические тексты — эти).
    TAB_DOC = {
        "review": ("Ревью карточек Notion в статусе «на ревью» локальными моделями.",
                   "Очередь → профиль (метод, состав, лимиты) → «Проверить» (dry-run) → "
                   "«Запустить». Исполняет council_worker раньше проработок, строго "
                   "последовательно. Итог — комментарий на карточке; перевод статуса — "
                   "только если разрешён политикой доски, по умолчанию с подтверждением."),
        "home": ("Новая задача с нуля — без карточки в Notion.",
                 "Заголовок + текст, при желании — до 5 связей с другими карточками "
                 "(выбор из дропдауна автокомплита по «@», не произвольный текст @[...] — "
                 "чипом становится и попадает консилиуму как контекст только выбранное). "
                 "Создаёт ЛОКАЛЬНЫЙ черновик и сразу ставит его в очередь; в Notion "
                 "ничего не пишется. Сюда ведёт название «AI Council» в шапке."),
        "overview": ("Состояние системы и ручное управление — одним экраном.",
                     "Начните здесь: чек-лист «с чего начать» и статистика, а ниже — "
                     "операции: синхронизация борда, индексация, сборка графа, план на "
                     "рабочее окно, серии запусков и запись результатов в Notion. "
                     "Перезапуск консилиума — тоже здесь, после правки настроек."),
        "quality": ("Отдаёт ли консилиум пользу — и во что превращаются ваши вердикты.",
                    "Классы причин воздержаний и надёжность каждой модели; здесь же "
                    "обучение: сколько вердиктов учтено, веса рецензентов и предложения "
                    "по ролям. Промпты система не правит сама — предлагает, решаете вы."),
        "feed": ("Прогоны с полным транскриптом и живая лента событий.",
                 "Счётчики показывают, сколько идёт сейчас и сколько прошло. Ваша "
                 "основная работа: открыть прогон и поставить вердикт — это "
                 "единственный сигнал обучения, без него качество не растёт."),
        "cards": ("Борд Notion как он виден консилиуму.",
                  "Отсюда карточка ставится в очередь с выбором профиля; карточки "
                  "с «Half-baked idea» не берутся, пока владелец не даст ОК."),
        "knowledge": ("Собственная база знаний и карта проекта по связям.",
                      "Проверьте поиском, находится ли то, на чём консилиум должен "
                      "опираться: пустой ответ здесь = слепой консилиум. Граф ниже "
                      "отвечает на «куда вообще ведёт задача»."),
        "cloud": ("Бюджет облака, режим «всё на GLM 5.x» и оба контура биллинга Z.AI. "
                  "Пункта в меню нет — вход через таблетку облака в шапке.",
                  "Здесь видно, сколько вызовов осталось в окне подписки, включается режим "
                  "GLM 5.x и проверяется связь по каждому контуру отдельно."),
        "settings": ("Конфиг и внешние API — то, что можно менять из браузера.",
                     "Ключи здесь не показываются и не правятся: только факт наличия "
                     "и место, откуда они читаются."),
    }

    def guide(self) -> dict:
        """Порядок работы, роль владельца и словарь терминов — из конфига, не из прозы.

        Подсистема из пяти демонов, двух биллинговых контуров, борда, индекса и графа не
        объясняется интерфейсом сама: вкладки показывают состояние, но не отвечают на
        «в каком порядке это делают» и «что здесь только моё дело». Пока ответ жил только
        в спеке, интерфейсом нельзя было пользоваться, не читая спеку.
        """
        budget = self.cfg.get("models.cloud.budget", {}) or {}
        writeback = self.cfg.get("outputs.notion_writeback", {}) or {}
        forbidden = sorted(k for k, v in writeback.items() if not v)
        profiles = []
        cloud_models = {m for node in (self.cfg.get("models.cloud.providers", {}) or {}).values()
                        for m in (node.get("models") or [])}
        for name, note in (("fast", "всё локально, самый быстрый — для простых карточек"),
                           ("deep", "предложения и арбитр облачные, скептик локальный — для critical/P0"),
                           ("hybrid", "предложения и рецензии локальные, арбитр облачный"),
                           ("cloud", "облако ведёт консилиум целиком — самый дорогой")):
            try:
                roster = self.cfg.roles(name)
            except Exception:                                   # noqa: BLE001
                continue
            per_run = (budget.get("max_calls_per_run_by_profile", {}) or {}).get(
                name, budget.get("max_calls_per_run", 0))
            uses_cloud = sorted({m for m in roster.values() if m in cloud_models})
            profiles.append({
                "name": name, "note": note, "roles": len(roster),
                "cloud_models": uses_cloud,
                "cloud_calls_per_card": per_run if uses_cloud else 0,
            })
        steps = [
            {"n": 1, "title": "Борд синхронизируется сам",
             "what": "Сервис notion-sync снимает карточки «Задач» и «Ошибок» каждые "
                     f"{self.cfg.get('sources.notion.poll_interval_min', 15)} мин. "
                     "Постановка живёт в Notion, здесь её копия.",
             "who": "сервис", "tab": "cards", "cost": "бесплатно",
             "op": "sync"},
            {"n": 2, "title": "База знаний и граф — перед первым прогоном",
             "what": "Без индекса консилиум работает без улик: капсула собирается из "
                     "кода, правил и спек, а граф отвечает на «куда ведёт задача».",
             "who": "владелец", "tab": "knowledge", "cost": "бесплатно, только время",
             "op": "reindex"},
            {"n": 3, "title": "Карточка ставится в очередь с профилем",
             "what": "Профиль решает, кто работает и сколько это стоит. Карточка с "
                     "«Half-baked idea» не берётся, пока владелец не даст ОК — сырую "
                     "постановку модель не чинит.",
             "who": "владелец", "tab": "cards", "cost": "профиль fast/deep — бесплатно; "
                                                        "hybrid/cloud — вызовы подписки"},
            {"n": 4, "title": "Консилиум прорабатывает",
             "what": "Предложения по ролям → рецензии → арбитраж → проверка на "
                     "выдуманные файлы и границы. Не уверен — воздерживается, а не "
                     "выдаёт правдоподобное.",
             "who": "консилиум", "tab": "feed",
             "cost": f"окно подписки: {budget.get('max_calls_per_window', 0)} вызовов "
                     f"за {budget.get('window_hours', 0)} ч"},
            {"n": 5, "title": "Владелец ставит вердикт",
             "what": "Принять / поправить / отклонить. Это единственный сигнал "
                     "обучения: без вердиктов система не отличает удачный прогон от "
                     "бесполезного.",
             "who": "владелец", "tab": "feed", "cost": "бесплатно"},
            {"n": 6, "title": "Результат уходит в Notion",
             "what": "Сначала «Показать, что уйдёт» (dry-run), потом «Записать». "
                     "Статус карточки и снятие Half-baked консилиуму не отданы — "
                     "это решает человек.",
             "who": "владелец", "tab": "overview", "cost": "бесплатно", "op": "emit"},
            {"n": 7, "title": "План на рабочее окно",
             "what": f"Планировщик пересобирает план каждые "
                     f"{self.cfg.get('planner.rebuild_minutes', 30)} мин: жёсткие "
                     "правила и скоринг, без «на своё усмотрение». В файлы — только "
                     "по явной команде.",
             "who": "сервис", "tab": "overview", "cost": "бесплатно", "op": "plan"},
            {"n": 8, "title": "Система учится на вердиктах",
             "what": f"Каждые {self.cfg.get('learning.rebuild_minutes', 30)} мин вердикты "
                     "и находки верификатора превращаются в надёжность моделей: "
                     "ненадёжный рецензент весит меньше, принятые результаты становятся "
                     "образцами. Перестановку ролей и правку промптов система только "
                     "ПРЕДЛАГАЕТ.",
             "who": "сервис", "tab": "quality", "cost": "бесплатно", "op": "learning"},
        ]
        glossary = [
            ("проработка", "разбор одной карточки консилиумом: предложения, рецензии, "
                           "арбитраж, проверка. Результат — блок в карточке Notion, а не "
                           "изменение кода."),
            ("вердикт", "решение владельца по прогону. Единственный источник обучения — "
                        "прогон без вердикта для системы не существует."),
            ("воздержание", "консилиум отказался отвечать: не хватило улик, участники не "
                            "сошлись или ответ не прошёл проверку. Это штатный исход, а не "
                            "сбой — цена ошибки выше цены молчания."),
            ("Half-baked idea", "пометка владельца на карточке: постановка сырая. Такие "
                                "карточки идут отдельным треком и в работу без явного «да» "
                                "не берутся."),
            ("окно подписки", f"скользящие {budget.get('window_hours', 0)} ч, за которые "
                              f"подписка Coding Plan даёт "
                              f"{budget.get('max_calls_per_window', 0)} вызовов. "
                              "Тарифицируется обращение, а не токены."),
            ("контур биллинга", "маршрут оплаты одного и того же провайдера. У Z.AI их два: "
                                "подписка (вызовы в окне) и General API (деньги за токены, "
                                "отдельный ключ и отдельный потолок)."),
            ("профиль", "состав участников прогона. От него зависит и качество, и цена: "
                        "локальные модели бесплатны, облачные тратят окно."),
            ("капсула", "выжимка контекста для одной карточки: постановка, релевантные "
                        "файлы, правила, куски базы знаний. Модель видит её, а не весь код."),
            ("лестница", "порядок обхода облачных моделей: сначала дешёвая ступень, "
                         "сильная — только если предыдущая не справилась."),
            ("надёжность модели", "доля принятого владельцем для тройки «модель + роль + "
                                  "модуль», Beta(α, β). Без данных ровно 0.50 — это не "
                                  "оценка, а отсутствие оценки."),
            ("наблюдение", "один учтённый сигнал: вердикт владельца или найденная "
                           f"верификатором выдумка. Пока их меньше "
                           f"{self.cfg.get('learning.min_observations', 3)}, надёжность "
                           "ни на что не влияет."),
        ]
        return {
            "steps": steps,
            "profiles": profiles,
            "glossary": [{"term": t, "text": x} for t, x in glossary],
            "owner_only": [
                "менять статус карточки в Notion (консилиум предлагает, решает человек)",
                "снимать «Half-baked idea»",
                "ставить вердикт по прогону",
                "разрешать запись в Notion (по умолчанию dry-run)",
                "включать облако и платный контур: оба открываются явным числом в конфиге",
            ],
            "forbidden_writeback": forbidden,
            "tabs": {name: {"what": what, "do": todo}
                     for name, (what, todo) in self.TAB_DOC.items()},
        }

    def api_status(self) -> dict:
        """Состояние внешних API: живость, откуда берётся ключ, есть ли он.

        Сам ключ не отдаётся никогда — ни целиком, ни хвостом. UI должен отвечать на
        вопрос «почему не работает», а для этого достаточно «ключ есть / ключа нет и
        вот где его ищут». Показывать даже часть ключа в веб-интерфейсе незачем:
        это не помогает диагностике, но создаёт способ его прочитать.
        """
        import cloud as cloud_mod
        import ollama as ollama_mod

        providers = []
        for name, spec in (self.cfg.get("models.cloud.providers", {}) or {}).items():
            key = cloud_mod.read_key(name)
            source = cloud_mod.KEY_SOURCES.get(name, ("—", "—"))
            entry = {
                "name": name,
                "base_url": spec.get("base_url", ""),
                "models": list(spec.get("models") or []),
                "timeout": spec.get("timeout_seconds"),
                "has_key": bool(key),
                "key_source": source[0] if isinstance(source, (list, tuple)) else str(source),
            }
            # Второй контур биллинга (у Z.AI — платный General API рядом с подпиской):
            # свой ключ, свой endpoint, свой суточный потолок.
            fallback = spec.get("fallback") or {}
            if fallback.get("enabled"):
                entry["fallback"] = {
                    "label": fallback.get("label", "второй контур"),
                    "base_url": fallback.get("base_url", ""),
                    "key_source": fallback.get("key_env", ""),
                    "has_key": bool(cloud_mod.read_key_from(
                        str(fallback.get("key_env", "")), str(fallback.get("key_file", "")))),
                    "when": list(fallback.get("when") or []),
                    "max_calls_per_day": fallback.get("max_calls_per_day", 0),
                    "max_usd_per_day": fallback.get("max_usd_per_day", 0),
                }
            providers.append(entry)

        ollama = ollama_mod.build(self.cfg)
        notion_key = self.cfg.notion_key()
        keyfile = self.cfg.path_of("sources.notion.key_file")

        headroom_url = str(self.cfg.get("models.cloud.headroom.url",
                                        "http://127.0.0.1:8787")).rstrip("/")
        headroom_ok = False
        try:
            with urllib.request.urlopen(headroom_url + "/health", timeout=2) as response:
                headroom_ok = 200 <= response.status < 300
        except Exception:                                       # noqa: BLE001
            headroom_ok = False

        rag = self.cfg.path_of("sources.rag.db")
        graph = self.cfg.path_of("sources.graph.path")
        return {
            "cloud_providers": providers,
            "cloud_enabled": self.cfg.cloud_enabled(),
            "ollama": {"url": ollama.base_url, "alive": ollama.alive()},
            "headroom": {
                "url": headroom_url, "alive": headroom_ok,
                "enabled": bool(self.cfg.get("models.cloud.headroom.enabled", False)),
                "providers": list(self.cfg.get("models.cloud.headroom.providers", []) or []),
                "dashboard": headroom_url + "/dashboard",
            },
            "notion": {
                "has_key": bool(notion_key),
                "key_file": str(self.cfg.get("sources.notion.key_file")),
                "key_file_exists": keyfile.is_file(),
                "key_file_mode": (oct(keyfile.stat().st_mode & 0o777)
                                  if keyfile.is_file() else None),
                "databases": {k: v.get("id") for k, v in
                              (self.cfg.get("sources.notion.databases", {}) or {}).items()},
            },
            "local_sources": {
                "rag_index": {"path": str(rag.relative_to(REPO_ROOT)) if rag.is_file()
                              else str(rag), "exists": rag.is_file()},
                "graph": {"path": "graphify-out/graph.json", "exists": graph.is_file()},
            },
        }

    def update_setting(self, key: str, raw_value) -> dict:
        """Точечная правка одного ключа в config.toml — построчно, с сохранением
        комментариев. TOML переписывается не целиком намеренно: см. EDITABLE."""
        if key not in self.EDITABLE:
            return {"ok": False, "error": f"ключ `{key}` не редактируется из UI"}
        _group, _label, kind, choices = self.EDITABLE[key]
        try:
            if kind == "bool":
                value = bool(raw_value) if isinstance(raw_value, bool) else \
                    str(raw_value).strip().lower() in {"1", "true", "on", "да"}
                literal = "true" if value else "false"
            elif kind == "int":
                value = int(raw_value)
                literal = str(value)
            elif kind == "float":
                value = float(raw_value)
                literal = repr(value)
            else:
                value = str(raw_value)
                if choices and value not in choices:
                    return {"ok": False, "error": f"допустимо только: {', '.join(choices)}"}
                literal = f'"{value}"'
        except (TypeError, ValueError):
            return {"ok": False, "error": f"значение `{raw_value}` не приводится к {kind}"}

        path = config_mod.CONFIG_PATH        # конфиг — код слоя, не данные хоста
        section, _, leaf = key.rpartition(".")
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            return {"ok": False, "error": f"конфиг недоступен: {exc}"}

        current, replaced = "", False
        for index, line in enumerate(lines):
            header = re.match(r"^\s*\[([^\]]+)\]\s*$", line)
            if header:
                current = header.group(1).strip()
                continue
            match = re.match(rf"^(\s*){re.escape(leaf)}(\s*=\s*)(.*?)(\s*(?:#.*)?)$", line)
            if match and current == section:
                lines[index] = f"{match.group(1)}{leaf}{match.group(2)}{literal}{match.group(4)}"
                replaced = True
                break
        if not replaced:
            return {"ok": False,
                    "error": f"ключ `{leaf}` не найден в секции [{section}] — правьте файл руками"}

        backup = path.with_suffix(".toml.bak")
        try:
            backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            # Перечитываем немедленно: если правка сделала конфиг невалидным, откат
            # должен произойти сейчас, а не при следующем старте воркера.
            fresh = config_mod.load(strict=False)
            # Лимиты режима «всё на GLM 5.x» (§17.6) — под валидатором: правка, после которой
            # режим стал бы непригоден (сутки < окна, потолок прогона > окна), откатывается.
            if key.startswith("models.glm_all."):
                before = set(getattr(self.cfg, "problems", None) or [])
                new = [p for p in getattr(fresh, "problems", None) or []
                       if "glm_all" in p and p not in before]
                if new:
                    raise config_mod.ConfigError("; ".join(new))
        except Exception as exc:                                # noqa: BLE001
            if backup.is_file():
                path.write_text(backup.read_text(encoding="utf-8"), encoding="utf-8")
            return {"ok": False, "error": f"откат: {exc}"}

        self.cfg = config_mod.load(strict=False)
        note = "сервисы подхватят после npm run ai-pipeline:restart"
        with self._store() as store:
            store.event("settings.changed", key, str(literal))
            # Облако выключено — тумблер «всё на GLM 5.x» гаснет вместе с ним: режим, который
            # молча идёт локально, врал бы шапке. Обратно — только явным включением.
            if key == "models.cloud.enabled" and not value and glm_mode.is_on(store):
                glm_mode.set_on(store, False, "cloud-off")
                note += "; режим GLM 5.x выключен вместе с облаком"
        log(f"настройка {key} = {literal}")
        return {"ok": True, "key": key, "value": value, "note": note}

    # ── указания владельца ───────────────────────────────────────────────────
    def notes(self, card_id: str) -> list[dict]:
        with self._store() as store:
            return store.card_notes(card_id, active_only=False)

    def add_note(self, card_id: str, note: str) -> dict:
        if not note.strip():
            return {"ok": False, "error": "пустое указание"}
        with self._store() as store:
            if not store.get_card(card_id):
                return {"ok": False, "error": f"карточка {card_id} не в снапшоте"}
            note_id = store.add_card_note(card_id, note)
        return {"ok": True, "id": note_id}

    # ── сессии владельца (P4/Ф2, план §P4 «Жизненный цикл», решение B) ─────────
    # Сессия = рабочее окно владельца (запуск→стоп), итоговый контекст принадлежит
    # ей, не карточке. store.py даёт только атомарные SQL-примитивы (см. его
    # docstring про сессии) — свёртка (LLM-вызов + индексация в corpus) дирижируется
    # здесь, тем же ленивым импортом ollama/context_service, что и остальной шлюз.
    def _close_and_summarize(self, store: Store, session_id: str) -> dict:
        if not store.close_session_if_open(session_id):
            return {"ok": False, "error": "сессия уже закрыта или не найдена"}
        import context_service
        import ollama as ollama_mod
        client = ollama_mod.build(self.cfg, store)
        summary = context_service.summarize_session(self.cfg, store, client, session_id)
        return {"ok": True, "session": store.get_session(session_id), "summary": summary}

    def _auto_close_idle(self, store: Store) -> None:
        """Ленивая проверка при каждом обращении к сессиям — не отдельный cron:
        поверхность и так минимальна (гейт [council.session_context] может быть
        выключен), плюс демон, который не запущен, не защитит от простоя лучше,
        чем проверка на следующий реальный запрос владельца."""
        ctx = self.cfg.get("council.session_context", {}) or {}
        if not ctx.get("enabled", False):
            return
        session = store.get_open_session()
        if not session:
            return
        last = store.q1(
            "SELECT COALESCE(MAX(r.finished_at), MAX(r.started_at)) ts "
            "FROM session_runs sr JOIN runs r ON r.id = sr.run_id WHERE sr.session_id = ?",
            (session["id"],)) or {}
        last_activity = last.get("ts") or session["opened_at"]
        idle_hours = float(ctx.get("idle_close_hours", 12))
        if time.time() - last_activity > idle_hours * 3600:
            self._close_and_summarize(store, session["id"])

    def open_session(self, title: str = "") -> dict:
        with self._store() as store:
            self._auto_close_idle(store)
            # Атомарно (review-p4.md, находка #1: закрыть-прежнюю-и-открыть-новую
            # тремя отдельными вызовами гонялось на параллельных запросах —
            # см. store.open_session_exclusive docstring). Свёртка прежней — уже
            # ПОСЛЕ commit'а, она не обязана держать write-лок сессии.
            session, prior = store.open_session_exclusive(title)
            closed_prior = None
            if prior:
                import context_service
                import ollama as ollama_mod
                client = ollama_mod.build(self.cfg, store)
                summary = context_service.summarize_session(self.cfg, store, client, prior["id"])
                closed_prior = {"ok": True, "session": store.get_session(prior["id"]),
                               "summary": summary}
            return {"ok": True, "session": session, "closed_prior": closed_prior}

    def close_session(self, session_id: str) -> dict:
        with self._store() as store:
            return self._close_and_summarize(store, session_id)

    def sessions(self, limit: int = 50) -> list[dict]:
        with self._store() as store:
            self._auto_close_idle(store)
            # review-p4.md, находка #4: LIMIT -1 в SQLite = без лимита — клэмп,
            # как уже сделано для knowledge() выше.
            return store.sessions_list(max(1, min(int(limit or 50), 100)))

    def session_detail(self, session_id: str) -> dict:
        with self._store() as store:
            session = store.get_session(session_id)
            if not session:
                return {}
            session["runs"] = store.session_runs(session_id)
            return session

    # ── база знаний ──────────────────────────────────────────────────────────
    # v2/Ф4: без запроса вкладка показывает не агрегаты, а КАТАЛОГ — полный список
    # документов с пагинацией. «Найдите вручную» было единственным способом увидеть
    # документ до сих пор; каталог отвечает на «что вообще лежит в корпусе» без
    # угадывания поисковых слов. Потолок page_size — 100 (аналог «findMany без take»).
    def knowledge(self, query: str = "", kind: str = "", page: int = 1,
                  page_size: int = 50) -> dict:
        page = max(1, int(page or 1))
        page_size = max(1, min(int(page_size or 50), 100))
        offset = (page - 1) * page_size
        with self._store() as store:
            kinds = store.q(
                "SELECT kind, COUNT(*) n FROM corpus_meta GROUP BY kind ORDER BY n DESC")
            embedded = store.q1("SELECT COUNT(*) n FROM corpus_vec") or {}
            hits: list[dict] = []
            total = 0
            kind_filter = " AND kind = ?" if kind else ""
            kind_params: tuple = (kind,) if kind else ()
            if query.strip():
                try:
                    total = (store.q1(
                        "SELECT COUNT(*) n FROM corpus WHERE corpus MATCH ?"
                        + kind_filter, (query.strip(),) + kind_params) or {}).get("n", 0)
                    hits = store.q(
                        "SELECT doc_id, kind, title, substr(content, 1, 400) snippet "
                        "FROM corpus WHERE corpus MATCH ?" + kind_filter
                        + " ORDER BY rank LIMIT ? OFFSET ?",
                        (query.strip(),) + kind_params + (page_size, offset))
                    for hit in hits:
                        meta = store.q1(
                            "SELECT source_ref FROM corpus_meta WHERE doc_id = ?",
                            (hit["doc_id"],)) or {}
                        hit["source_ref"] = meta.get("source_ref") or ""
                except Exception as exc:                        # noqa: BLE001
                    return {"kinds": kinds, "embedded": embedded.get("n", 0),
                            "hits": [], "error": f"неверный запрос FTS5: {exc}",
                            "mode": "search", "page": page, "page_size": page_size,
                            "total": 0, "pages": 1}
            else:
                # Листинг: JOIN с corpus_meta ради source_ref и даты индексации —
                # то, что FTS-таблица сама не отдаёт.
                total = (store.q1(
                    "SELECT COUNT(*) n FROM corpus c JOIN corpus_meta m USING(doc_id)"
                    " WHERE 1=1" + kind_filter.replace("kind", "m.kind"),
                    kind_params) or {}).get("n", 0)
                hits = store.q(
                    "SELECT c.doc_id, c.kind, c.title, substr(c.content, 1, 260) snippet, "
                    "m.module, m.source_ref, m.indexed_at "
                    "FROM corpus c JOIN corpus_meta m USING(doc_id) WHERE 1=1"
                    + kind_filter.replace("kind", "m.kind")
                    + " ORDER BY c.kind, c.title LIMIT ? OFFSET ?",
                    kind_params + (page_size, offset))
            pages = max(1, -(-total // page_size))
            return {"kinds": kinds, "embedded": embedded.get("n", 0), "hits": hits,
                    "page": page, "page_size": page_size, "total": total,
                    "pages": pages, "mode": "search" if query.strip() else "catalog"}

    # ── граф ─────────────────────────────────────────────────────────────────
    # Разобранный graph.json держим в памяти процесса: файл — 90+ МБ, и парсить его на
    # каждое открытие вкладки значит секунды ожидания на ровном месте. Ключ кэша —
    # (mtime, размер): пересборка графа сама себя инвалидирует.
    # Парсинг/кэш/обход graph.json — общий с MCP-инструментом `council_graph_neighbors`,
    # вынесены в graph_index.py (план §P4/Ф2). Обёртки ниже — тонкие делегаты, а не
    # копии логики: имена сохранены, потому что test_graph_communities_empty_filter_guard
    # подменяет `api._graph_index` инстансным атрибутом и вызывает `Api._filter_adj`/
    # `_graph_communities`/`_community_subgraph` как статики напрямую с класса.
    def _graph_index(self, path: Path) -> dict:
        return graph_index_mod.load_index(path)

    @staticmethod
    def _graph_slice(meta: dict, adj: dict, limit: int) -> tuple[list, list]:
        return graph_index_mod.graph_slice(meta, adj, limit)

    @staticmethod
    def _filter_adj(adj: dict, rels: set[str] | None) -> dict:
        return graph_index_mod.filter_adj(adj, rels)

    @staticmethod
    def _graph_communities(meta: dict, adj: dict, rels: set[str] | None) -> tuple[list, list]:
        return graph_index_mod.graph_communities(meta, adj, rels)

    @staticmethod
    def _community_subgraph(meta: dict, adj: dict, community_id: str) -> tuple[dict, dict]:
        return graph_index_mod.community_subgraph(meta, adj, community_id)

    def graph(self, limit: int = 300, level: str = "files", rel: str = "") -> dict:
        """Срез графа для отрисовки. Целиком не отдаём: 68 тысяч узлов браузер не рисует,
        а смысла в «всё сразу» нет — читаемости от этого не прибавляется. `level=communities`
        — единственный режим выше 2500 узлов (план §3в), `limit` в нём не участвует: узлов
        ровно столько, сколько сообществ, это по определению немного (сотни, не тысячи)."""
        path = self.cfg.path_of("sources.graph.path")
        if not path.is_file():
            return {"available": False,
                    "hint": "graphify-out/graph.json нет — построить: /graphify",
                    "path": str(path)}
        try:
            index = self._graph_index(path)
        except (OSError, ValueError) as exc:
            return {"available": False, "hint": f"граф не читается: {exc}"}

        level = level if level in ("files", "symbols", "communities") else "files"
        rels = {r.strip() for r in rel.split(",") if r.strip()} or None

        if level == "communities":
            symbols = index["symbols"]
            if not symbols["adj"]:
                return {"available": False, "hint": "в графе нет связей — нечего показывать"}
            nodes_out, edges_out = self._graph_communities(symbols["meta"], symbols["adj"], rels)
            # Тот же гард, что у files/symbols (строка выше): фильтр по связи мог не оставить
            # ни одного межобщинного ребра — тогда это не «граф пуст» (сообщества есть), а
            # именно «после фильтра нет межобщинных связей», иначе UI молча рисует облако
            # несвязанных точек без объяснения.
            if rels and not edges_out:
                return {"available": False,
                        "hint": "после фильтра связей нет ни одной межобщинной связи — "
                                "сообщества остались бы не связаны друг с другом"}
            return {"available": True, "level": level, "limit": None,
                    "total_nodes": index["total_nodes"], "total_edges": index["total_edges"],
                    "level_nodes": len(nodes_out), "available_relations": index["relations"],
                    "nodes": nodes_out, "edges": edges_out}

        layer = index[level]
        if not layer["adj"]:
            return {"available": False, "hint": "в графе нет связей — нечего показывать"}
        adj = self._filter_adj(layer["adj"], rels)
        if not adj:
            return {"available": False, "hint": "после фильтра связей граф пуст — нечего показывать"}
        # Потолок для files/symbols — жёсткий и не зависит от того, что прислал клиент
        # (даже «all»/огромное число): выше 2500 — только через level=communities.
        limit = max(50, min(int(limit), 2500))
        nodes_out, edges_out = self._graph_slice(layer["meta"], adj, limit)
        return {"available": True, "level": level, "limit": limit,
                "total_nodes": index["total_nodes"], "total_edges": index["total_edges"],
                "level_nodes": len(layer["adj"]), "available_relations": index["relations"],
                "nodes": nodes_out, "edges": edges_out}

    def graph_community(self, community_id: str, limit: int = 1000, level: str = "symbols",
                         rel: str = "") -> dict:
        """Ленивая догрузка области (план §3в, решение D): детальный связный срез ОДНОГО
        сообщества по клику/зуму — а не весь граф одним ответом. `limit` здесь — та же
        шкала бюджета, но верхняя граница выше (25000): сообщество может быть большим,
        а UI грузит его отдельным запросом, не блокируя первый (LOD) экран."""
        path = self.cfg.path_of("sources.graph.path")
        if not path.is_file():
            return {"available": False,
                    "hint": "graphify-out/graph.json нет — построить: /graphify"}
        try:
            index = self._graph_index(path)
        except (OSError, ValueError) as exc:
            return {"available": False, "hint": f"граф не читается: {exc}"}

        level = level if level in ("files", "symbols") else "symbols"
        # UI кликает по узлу LOD-графа, чей id — "community:<label>" (см. _graph_communities);
        # принимаем оба варианта, чтобы фронту не нужно было знать про префикс.
        if community_id.startswith("community:"):
            community_id = community_id[len("community:"):]
        layer = index[level]
        sub_meta, sub_adj = self._community_subgraph(layer["meta"], layer["adj"], community_id)
        if not sub_meta:
            return {"available": False, "hint": f"сообщество {community_id!r} не найдено"}
        rels = {r.strip() for r in rel.split(",") if r.strip()} or None
        sub_adj = self._filter_adj(sub_adj, rels)
        limit = max(50, min(int(limit), 25000))
        nodes_out, edges_out = self._graph_slice(sub_meta, sub_adj, limit)
        return {"available": True, "level": level, "community": community_id, "limit": limit,
                "community_size": len(sub_meta), "available_relations": index["relations"],
                "nodes": nodes_out, "edges": edges_out}

    def graph_neighbors(self, node: str, hops: int = 1, limit: int = 50,
                        level: str = "files", rel: str = "") -> dict:
        """P4/Ф2 — вход MCP `council_graph_neighbors`: N-шаговое окружение ОДНОГО узла
        по имени/label, не связный кусок произвольного размера (это `graph()`, для
        3D-визуализации целиком)."""
        path = self.cfg.path_of("sources.graph.path")
        if not path.is_file():
            return {"available": False,
                    "hint": "graphify-out/graph.json нет — построить: /graphify"}
        try:
            index = self._graph_index(path)
        except (OSError, ValueError) as exc:
            return {"available": False, "hint": f"граф не читается: {exc}"}
        return graph_index_mod.neighbors(index, node, hops, limit, level, rel)

    # ── качество и процессы ──────────────────────────────────────────────────
    def quality(self, days: int = 7) -> dict:
        """Дашборд качества. Считается по журналу прогонов, не по ощущениям: главный
        вопрос — «консилиум вообще даёт результат или воздерживается», и он должен
        отвечаться числом, потому что именно оно уехало в прошлый раз (6 воздержаний
        из 8) и никто этого не видел.

        `days` — окно для таблицы «модель/роль» (0 — вся история)."""
        with self._store() as store:
            by_status = {r["status"]: r["n"] for r in store.q(
                "SELECT status, COUNT(*) n FROM runs GROUP BY status")}
            finished = sum(by_status.get(s, 0) for s in ("done", "abstained", "failed"))
            done = by_status.get("done", 0)

            by_profile = store.q(
                "SELECT profile, COUNT(*) n, "
                "SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done, "
                "AVG(CASE WHEN status='done' THEN readiness END) readiness, "
                "AVG(CASE WHEN status='done' THEN confidence END) confidence, "
                "AVG(wall_ms) wall_ms FROM runs GROUP BY profile ORDER BY n DESC")

            # Причины воздержания — не текстом целиком, а по классам: одинаковые причины
            # формулируются по-разному, а лечатся одинаково.
            reasons = []
            for row in store.q(
                    "SELECT outcome FROM runs WHERE status='abstained' AND outcome <> ''"):
                text = row["outcome"]
                if "несуществующих" in text or "выдум" in text:
                    bucket = "выдуманные ссылки (верификатор)"
                elif "по-разному" in text or "совпадение файлов" in text:
                    bucket = "модели не сошлись в скоупе"
                elif "ниже порога" in text:
                    bucket = "оценка ниже порога рубрики"
                elif "не дал валидного" in text or "арбитр" in text:
                    bucket = "модель не ответила"
                else:
                    bucket = "прочее"
                reasons.append(bucket)
            reason_counts = [{"reason": r, "n": reasons.count(r)}
                             for r in sorted(set(reasons), key=lambda x: -reasons.count(x))]

            running = store.q(
                "SELECT r.id, r.card_id, r.profile, r.track, r.started_at, r.claimed_by, "
                "c.title FROM runs r LEFT JOIN cards c ON c.card_id = r.card_id "
                "WHERE r.status IN ('running','queued') "
                "ORDER BY CASE r.status WHEN 'running' THEN 0 ELSE 1 END, r.priority DESC "
                "LIMIT 40")
            recent = store.q(
                "SELECT r.id, r.status, r.profile, r.readiness, r.confidence, r.wall_ms, "
                "r.finished_at, c.title FROM runs r LEFT JOIN cards c "
                "ON c.card_id = r.card_id WHERE r.finished_at IS NOT NULL "
                "ORDER BY r.finished_at DESC LIMIT 20")

            verdicts = {r["decision"]: r["n"] for r in store.q(
                "SELECT decision, COUNT(*) n FROM verdicts GROUP BY decision")}
            models = model_reliability(store, days)
            cards_covered = store.q1(
                "SELECT COUNT(DISTINCT card_id) n FROM runs WHERE status='done'") or {}
            total_cards = store.q1("SELECT COUNT(*) n FROM cards") or {}

            return {
                "runs": {"by_status": by_status, "finished": finished, "done": done,
                         "done_rate": round(done / finished, 3) if finished else 0.0},
                "by_profile": by_profile,
                "abstain_reasons": reason_counts,
                "running": running,
                "recent": recent,
                "verdicts": verdicts,
                "models": models["rows"],
                "models_window": {"days": days, "since": models["since"],
                                  "cloud_refusals": models["cloud_refusals"],
                                  "cloud_refusals_outside": models["cloud_refusals_outside"]},
                "coverage": {"cards_with_result": cards_covered.get("n", 0),
                             "cards_total": total_cards.get("n", 0)},
            }

    # ── обучение (§9) ────────────────────────────────────────────────────────
    def learning(self, module: str = "*") -> dict:
        """Что система выучила и на чём это основано.

        Раздел отвечает на вопрос, который до P5 не имел ответа нигде: «мои вердикты
        куда-нибудь деваются?». Поэтому здесь не только веса, но и весь путь сигнала —
        сколько прогонов ждут вердикта, сколько вердиктов учтено, во что они превратились
        и что из этого уже влияет на прогоны.
        """
        with self._store() as store:
            modules = [row["module"] for row in store.q(
                "SELECT DISTINCT module FROM model_stats ORDER BY module")]
            table = learning_mod.reliability_table(store, module)
            ledger = {row["kind"]: row["n"] for row in store.q(
                "SELECT kind, COUNT(*) n FROM learning_ledger GROUP BY kind")}
            verdicts = {row["decision"]: row["n"] for row in store.q(
                "SELECT decision, COUNT(*) n FROM verdicts GROUP BY decision")}
            awaiting = (store.q1(
                "SELECT COUNT(*) n FROM runs r WHERE r.status IN ('done','abstained') "
                "AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.run_id = r.id)") or {}
                ).get("n", 0)
            exemplars = (store.q1(
                "SELECT COUNT(*) n FROM corpus_meta WHERE kind = 'exemplar'") or {}).get("n", 0)
            weighted_reviews = store.q(
                "SELECT reviewer_model model, reviewer_role role, COUNT(*) n, AVG(weight) w "
                "FROM reviews GROUP BY reviewer_model, reviewer_role ORDER BY n DESC LIMIT 20")
            rubric = learning_mod.suggestions(store)

            board = learning_mod.role_board(self.cfg, store, module)
            # model_stats хранит только пары, по которым уже был сигнал, а на вкладке нужна вся сетка
            # «модель × роль», из которой совет выбирает. Недостающие пары — строкой с приором 1/1:
            # 0.50 и ноль наблюдений; в «общую массу» они ничего не добавляют.
            seen = {(row["model"], row["role"]) for row in table}
            for role, candidates in (board.get("roles") or {}).items():
                for cand in candidates:
                    if (cand["model"], role) in seen:
                        continue
                    seen.add((cand["model"], role))
                    table.append({"model": cand["model"], "role": role, "module": module,
                                  "alpha": 1.0, "beta": 1.0, "reliability": 0.5, "observations": 0.0,
                                  "updated_at": None, "prior": True})
            clouds = set(board["cloud"])
            for row in table:
                row["cloud"] = row["model"] in clouds
            recommendations = [learning_mod.role_recommendation(self.cfg, store, profile, module)
                               for profile in learning_mod.BOARD_PROFILES]

            return {
                "enabled": bool(self.cfg.get("learning.enabled", True)),
                "settings": {
                    "review_weighting": bool(self.cfg.get("learning.review_weighting", True)),
                    "role_selection": bool(self.cfg.get("learning.role_selection", False)),
                    "min_observations": self.cfg.get("learning.min_observations", 3),
                    "rubric_drift_suggest_after":
                        self.cfg.get("learning.rubric_drift_suggest_after", 3),
                    "rebuild_minutes": self.cfg.get("learning.rebuild_minutes", 30),
                },
                "module": module, "modules": modules,
                "reliability": table,
                "signals": {"verdicts_counted": ledger.get("verdict", 0),
                            "hallucinations_counted": ledger.get("hallucination", 0),
                            "verdicts": verdicts, "awaiting_verdict": awaiting,
                            "exemplars": exemplars},
                "reviews": weighted_reviews,
                "recommendations": recommendations,
                "role_board": board,
                "rubric": rubric,
            }

    def rubric_decide(self, suggestion_id: int, status: str) -> dict:
        with self._store() as store:
            return learning_mod.decide_suggestion(store, int(suggestion_id), status)

    # ── статусы Notion ───────────────────────────────────────────────────────
    # Консилиум статусы не двигает (C4, rules/17 §6) — их двигает человек. Отсюда две
    # разные операции: автоматический writeback (`status_changes`, выключен) и явное
    # действие владельца из UI. Второе разрешено, но с потолком «на ревью»: перевод в
    # финальный статус остаётся ручным действием в самом Notion, чтобы UI консилиума
    # не стал способом закрыть карточку мимо правила.
    STATUSES = {
        "tasks": ["задача от пользователя", "прожаренные явные задачи", "в работе",
                  "на ревью"],
        "bugs": ["открыто", "в работе", "на ревью"],
    }

    # ── Настройки → «Модели и промпты» (bindings.py) ────────────────────────
    def _available_models(self) -> tuple[list[str], list[str]]:
        import ollama as ollama_mod
        client = ollama_mod.build(self.cfg)
        installed = sorted(client.installed_models()) if client.alive() else []
        cloud = sorted({m for node in (self.cfg.get("models.cloud.providers", {}) or {}).values()
                        for m in (node.get("models") or [])})
        return installed, cloud

    def bindings(self) -> dict:
        import bindings as bindings_mod
        import ollama as ollama_mod
        client = ollama_mod.build(self.cfg)
        installed, cloud = self._available_models()
        return bindings_mod.overview(self.cfg, installed, cloud, client.is_large)

    def _reload_cfg(self) -> None:
        """Шлюз показывает правку сразу; воркеры подхватят после перезапуска."""
        self.cfg = config_mod.load(strict=False)
        if Handler.review is not None:
            Handler.review.cfg = self.cfg

    def set_binding(self, body: dict) -> dict:
        import bindings as bindings_mod
        try:
            if body.get("kind") == "role":
                installed, cloud = self._available_models()
                res = bindings_mod.set_role_model(self.cfg, str(body.get("profile") or ""),
                                                  str(body.get("role") or ""),
                                                  str(body.get("model") or ""), set(installed) | set(cloud))
            elif body.get("kind") == "prompt":
                res = bindings_mod.set_prompt_binding(self.cfg, str(body.get("slot") or ""),
                                                      str(body.get("prompt") or ""))
            else:
                return {"ok": False, "error": "kind: role | prompt"}
        except bindings_mod.BindingError as exc:
            return {"ok": False, "error": str(exc)}
        self._reload_cfg()
        with self._store() as store:
            store.event("bindings.changed", body.get("kind", ""), json.dumps(res, ensure_ascii=False))
        log(f"привязка: {res}")
        return {**res, "restart_needed": True}

    def prompt(self, name: str) -> dict:
        import bindings as bindings_mod
        try:
            return bindings_mod.read_prompt(name)
        except bindings_mod.BindingError as exc:
            return {"error": str(exc)}

    def save_prompt(self, body: dict) -> dict:
        import bindings as bindings_mod
        try:
            res = bindings_mod.write_prompt(str(body.get("name") or ""), str(body.get("text") or ""),
                                            create_only=bool(body.get("create_only")))
        except bindings_mod.BindingError as exc:
            return {"ok": False, "error": str(exc)}
        with self._store() as store:
            store.event("prompt.saved", res["name"], res["sha"])
        log(f"промпт {res['name']} сохранён ({res['sha']})")
        return {"ok": True, **res}

    def set_status(self, card_id: str, status: str) -> dict:
        with self._store() as store:
            card = store.get_card(card_id)
            if not card:
                return {"ok": False, "error": f"карточка {card_id} не в снапшоте"}
            allowed = self.STATUSES.get(card["db"], [])
            if status not in allowed:
                return {"ok": False,
                        "error": f"из UI доступны только: {', '.join(allowed)}. "
                                 f"Финальный статус ставится вручную в Notion "
                                 f"(.claude/rules/17-notion-board.md §6)"}
            import notion as notion_mod
            try:
                client = notion_mod.build(self.cfg, dry_run=False)
                # Имя свойства одинаково в обеих базах — Status (select).
                client.call(f"/pages/{card_id}", "PATCH",
                            {"properties": {"Status": {"select": {"name": status}}}})
            except Exception as exc:                            # noqa: BLE001
                return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            store.x("UPDATE cards SET status = ? WHERE card_id = ?", (status, card_id))
            store.log_notion_write("", card_id, "status", "Status",
                                   card.get("status") or "", status, True)
            store.event("status.changed", card_id, f"{card.get('status')} → {status}")
        log(f"статус {card_id}: {card.get('status')} → {status}")
        return {"ok": True, "status": status}

    # ── операции ─────────────────────────────────────────────────────────────
    # Шлюз умеет запускать ТОЛЬКО перечисленное здесь и ровно с этими аргументами.
    # Произвольной команды из UI нет и не будет: у шлюза нет авторизации (он живёт на
    # петле), и «выполни строку» превратило бы вкладку браузера в удалённый шелл.
    # Аргументы, которые UI всё же передаёт (окно плана), валидируются как даты/время.
    OPS = {
        "sync":     ("Синхронизировать борд Notion", ["notion_sync.py", "--once"]),
        "reindex":  ("Переиндексировать базу знаний", ["context_service.py", "--once"]),
        "graph":    ("Собрать граф проекта", ["graph_build.py"]),
        "learning": ("Учесть вердикты и поискать дрейф рубрики", ["learning.py", "--once"]),
        "plan":     ("Собрать план (черновик)", ["planner_service.py", "--once"]),
        "plan_apply": ("Собрать план и записать", ["planner_service.py", "--once", "--apply"]),
        "emit":     ("Показать, что уйдёт в Notion", ["emit.py", "--pending"]),
        "emit_apply": ("Записать результаты в Notion", ["emit.py", "--pending", "--apply"]),
        "selftest": ("Самопроверки", ["selftest.py"]),
        "doctor":   ("Предполётная проверка", ["supervisor.py", "doctor"]),
        "council_start":   ("Запустить консилиум", ["supervisor.py", "start"]),
        "council_stop":    ("Остановить консилиум", ["supervisor.py", "stop"]),
        "council_restart": ("Перезапустить консилиум", ["supervisor.py", "restart"]),
    }
    # Операции, которые меняют состояние снаружи (Notion) или процессное дерево.
    # UI обязан спрашивать подтверждение — здесь это только пометка для интерфейса.
    OPS_DESTRUCTIVE = {"emit_apply", "plan_apply", "council_stop", "council_restart"}

    _jobs: dict = {}
    _jobs_lock = threading.Lock()

    def ops_list(self) -> dict:
        return {
            "ops": [{"name": name, "title": title,
                     "destructive": name in self.OPS_DESTRUCTIVE}
                    for name, (title, _cmd) in self.OPS.items()],
            "jobs": self.jobs(),
        }

    def jobs(self) -> list[dict]:
        with self._jobs_lock:
            items = list(self._jobs.values())
        items.sort(key=lambda j: -(j.get("started_at") or 0))
        return [{k: v for k, v in job.items() if k != "output"} | {
            "output_tail": "\n".join((job.get("output") or "").splitlines()[-40:])
        } for job in items[:12]]

    def run_op(self, name: str, params: dict | None = None) -> dict:
        if name not in self.OPS:
            return {"ok": False, "error": f"операция `{name}` не разрешена"}
        with self._jobs_lock:
            busy = [j for j in self._jobs.values()
                    if j["name"] == name and j["status"] == "running"]
        if busy:
            return {"ok": False, "error": f"`{name}` уже выполняется"}

        title, argv = self.OPS[name]
        cmd = [sys.executable, str(HERE / argv[0])] + list(argv[1:])
        # Единственные принимаемые снаружи аргументы — окно планирования. Формат
        # проверяется здесь, а не «доверяется UI»: строка уходит в argv процесса.
        for key, flag, pattern in (("date", "--date", r"^[\d\-\+a-z]{1,20}$"),
                                   ("time_from", "--from", r"^\d{1,2}:\d{2}$"),
                                   ("time_to", "--to", r"^\d{1,2}:\d{2}$")):
            value = str((params or {}).get(key) or "").strip()
            if value and name.startswith("plan"):
                if not re.match(pattern, value):
                    return {"ok": False, "error": f"значение `{value}` не подходит для {flag}"}
                cmd += [flag, value]

        job_id = f"{name}-{int(time.time())}"
        job = {"id": job_id, "name": name, "title": title, "status": "running",
               "started_at": int(time.time()), "finished_at": None, "code": None,
               "output": "", "cmd": " ".join(argv)}
        with self._jobs_lock:
            self._jobs[job_id] = job

        def worker() -> None:
            try:
                proc = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True,
                                      text=True, timeout=3600)
                out = ((proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")).strip()
                job["code"] = proc.returncode
                job["status"] = "done" if proc.returncode == 0 else "failed"
                job["output"] = out[-20000:]
            except subprocess.TimeoutExpired:
                job["status"], job["code"] = "failed", -1
                job["output"] = "превышен лимит времени операции (1 час)"
            except Exception as exc:                            # noqa: BLE001
                job["status"], job["code"] = "failed", -1
                job["output"] = f"{type(exc).__name__}: {exc}"
            job["finished_at"] = int(time.time())
            try:
                with self._store() as store:
                    store.event(f"op.{job['status']}", name,
                                (job["output"] or "").splitlines()[-1][:180]
                                if job["output"] else "")
            except Exception:                                   # noqa: BLE001
                pass
            log(f"операция {name}: {job['status']} (код {job['code']})")

        threading.Thread(target=worker, daemon=True, name=f"op-{name}").start()
        return {"ok": True, "job_id": job_id, "title": title}

    # ── серии карточек с окном запуска ───────────────────────────────────────
    def estimate(self, profile: str, count: int, cloud_mode: str = "") -> dict:
        """Сколько это займёт. Считается по СВОЕЙ истории прогонов этого профиля,
        а не по константе: на этой машине разброс между fast и deep — в разы, и
        «примерно час» без опоры на замер вводит в заблуждение сильнее, чем молчание."""
        with self._store() as store:
            # GLM 5.x — отметка задачи или тумблер шапки: облачные все роли, потолок — режима.
            glm = cloud_mode == glm_mode.CLOUD_MODE or glm_mode.status(store, self.cfg)["effective"]
            row = store.q1(
                "SELECT AVG(wall_ms) avg_ms, COUNT(*) n FROM runs "
                "WHERE profile = ? AND wall_ms IS NOT NULL AND status IN ('done','abstained')",
                (profile,)) or {}
        if glm:
            g = glm_mode.settings(self.cfg)
            out = self._estimate_from(row, profile, count)
            out.update({"glm": True, "cloud_calls": g["max_calls_per_run"] * max(count, 0),
                        "glm_window": {"max": g["max_calls_per_window"], "hours": g["window_hours"]}})
            return out
        return self._estimate_from(row, profile, count)

    def _estimate_from(self, row: dict, profile: str, count: int) -> dict:
        avg_ms = float(row.get("avg_ms") or 0)
        measured = int(row.get("n") or 0)
        if not avg_ms:
            # Нет собственного замера — берём грубый ориентир по ярусу, честно помечая.
            avg_ms = {"fast": 60_000, "deep": 240_000,
                      "hybrid": 260_000, "cloud": 470_000}.get(profile, 120_000)
        total = int(avg_ms * max(count, 0) / 1000)
        return {"per_card_seconds": int(avg_ms / 1000), "total_seconds": total,
                "measured_on": measured,
                "cloud_calls": (self.cfg.get("models.cloud.budget."
                                             "max_calls_per_run_by_profile", {}) or {})
                .get(profile, 0) * max(count, 0)}

    def enqueue_batch(self, card_ids: list[str], profile: str, note: str = "",
                      start_at: int | None = None, deadline: int | None = None,
                      priority: int = 5, cloud_mode: str = "") -> dict:
        allowed = ("fast", "deep", "hybrid", "cloud")
        if profile not in allowed:
            return {"ok": False, "error": f"профиль должен быть одним из {allowed}"}
        cloud_mode, why = self._cloud_mode(cloud_mode)
        if why:
            return {"ok": False, "error": why}
        if profile in ("hybrid", "cloud") and not self.cfg.cloud_enabled():
            return {"ok": False, "error": f"профиль `{profile}` требует включённого облака"}
        if not card_ids:
            return {"ok": False, "error": "не выбрано ни одной карточки"}
        if deadline and start_at and deadline <= start_at:
            return {"ok": False, "error": "конец окна раньше начала"}

        batch_id = f"batch_{int(time.time())}"
        queued, skipped = [], []
        with self._store() as store:
            for card_id in card_ids:
                card = store.get_card(card_id)
                if not card:
                    skipped.append(card_id)
                    continue
                # Комментарий к запуску сохраняется как указание владельца по каждой
                # карточке серии — иначе он жил бы только в этой сессии и не дошёл бы
                # до моделей вовсе.
                if note.strip():
                    store.add_card_note(card_id, note.strip())
                run_id = store.enqueue(
                    card_id, track="half_baked" if card["half_baked"] else "elaborate",
                    profile=profile, priority=priority, config_hash=self.cfg.config_hash(),
                    git_sha=git_sha(), card_hash=card.get("content_hash") or "",
                    dedupe=True, not_before=start_at, expires_at=deadline,
                    batch_id=batch_id, cloud_mode=cloud_mode)
                (queued if run_id else skipped).append(card_id)
            store.event("batch.queued", batch_id, json.dumps(
                {"profile": profile, "cards": len(queued), "start_at": start_at,
                 "deadline": deadline, "cloud_mode": cloud_mode}, ensure_ascii=False))
        log(f"серия {batch_id}: {len(queued)} карточек, профиль {profile}"
            f"{', GLM 5.x' if cloud_mode else ''}")
        return {"ok": True, "batch_id": batch_id, "queued": len(queued),
                "skipped": len(skipped),
                "estimate": self.estimate(profile, len(queued), cloud_mode)}

    def cancel_queued(self, batch_id: str = "") -> dict:
        """Снять из очереди. Идущие прогоны не трогаем: обрывать карточку на середине
        значит потратить вызовы и не получить результат."""
        with self._store() as store:
            if batch_id:
                cur = store.x("UPDATE runs SET status='cancelled', "
                              "outcome='снято владельцем' WHERE status='queued' "
                              "AND batch_id = ?", (batch_id,))
            else:
                cur = store.x("UPDATE runs SET status='cancelled', "
                              "outcome='снято владельцем' WHERE status='queued'")
            store.event("batch.cancelled", batch_id, str(cur.rowcount))
        return {"ok": True, "cancelled": cur.rowcount}

    def batches(self) -> list[dict]:
        with self._store() as store:
            return store.q(
                "SELECT batch_id, profile, COUNT(*) total, "
                "SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued, "
                "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running, "
                "SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done, "
                "SUM(CASE WHEN status='abstained' THEN 1 ELSE 0 END) abstained, "
                "SUM(CASE WHEN status IN ('expired','cancelled') THEN 1 ELSE 0 END) dropped, "
                "SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) paused, "
                "SUM(CASE WHEN status IN ('expired','cancelled') AND started_at IS NULL "
                "AND (status='expired' OR outcome LIKE 'снято%' OR outcome LIKE 'приостановлено%') "
                "AND NOT EXISTS (SELECT 1 FROM runs o WHERE o.card_id = runs.card_id "
                "AND o.track = runs.track AND o.id != runs.id "
                "AND o.status IN ('queued', 'running', 'paused')) "
                "THEN 1 ELSE 0 END) resumable, "
                "MIN(not_before) not_before, MAX(expires_at) expires_at, "
                "MIN(created_at) created_at FROM runs WHERE batch_id IS NOT NULL "
                "GROUP BY batch_id, profile ORDER BY created_at DESC LIMIT 20")

    def events(self, since: int, limit: int = 200) -> list[dict]:
        with self._store() as store:
            return store.events_since(since, limit)

    def events_tail(self, n: int = 80) -> list[dict]:
        """Последние n событий по возрастанию id — чем заполнить ленту при открытии."""
        n = max(1, min(int(n), 500))
        with self._store() as store:
            rows = store.q("SELECT * FROM events ORDER BY id DESC LIMIT ?", (n,))
        return list(reversed(rows))

    UNREAD_CAP = 1000

    def events_unread(self, since: str) -> dict:
        """Сколько событий после `since` — счётчик на таблетке «лента». Считается до
        UNREAD_CAP: точнее UI не показывает («999+»), а COUNT по всему журналу дороже.
        Пустой since (первый заход браузера) — 0 и текущий хвост: «новое» начинается
        с этого момента, а не со всей истории журнала."""
        latest = self.latest_event_id()
        if not str(since).strip().lstrip("-").isdigit():
            return {"count": 0, "capped": False, "latest": latest}
        with self._store() as store:
            row = store.q1("SELECT COUNT(*) n FROM (SELECT 1 FROM events WHERE id > ? LIMIT ?)",
                           (int(since), self.UNREAD_CAP)) or {}
        n = int(row.get("n") or 0)
        return {"count": n, "capped": n >= self.UNREAD_CAP, "latest": latest}

    def latest_event_id(self) -> int:
        """Хвост журнала — точка, с которой лента считается «живой»."""
        with self._store() as store:
            row = store.q1("SELECT COALESCE(MAX(id), 0) id FROM events") or {}
            return int(row.get("id") or 0)


def _loads(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


# ─────────────────────────────────────────────────────────────────────────────
# HTTP
# ─────────────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    api: Api = None                     # проставляется в serve()
    review: ReviewApi = None            # вкладка «Ревью», проставляется в serve()
    server_version = "AICouncilGateway/1.0"

    def log_message(self, fmt, *args):  # noqa: A003 — гасим болтливый лог BaseHTTPServer
        return

    # ── ответы ───────────────────────────────────────────────────────────────
    def _send(self, code: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass                        # вкладку закрыли посреди ответа — это норма

    def _json(self, payload, code: int = 200) -> None:
        self._send(code, json.dumps(payload, ensure_ascii=False,
                                    default=str).encode("utf-8"))

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8")) or {}
        except (ValueError, UnicodeDecodeError):
            return {}

    # ── маршруты ─────────────────────────────────────────────────────────────
    def do_GET(self) -> None:            # noqa: N802 — имя задано BaseHTTPRequestHandler
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        one = lambda key, default="": (query.get(key) or [default])[0]   # noqa: E731

        try:
            if route in ("/", "/index.html"):
                return self._send(200, _ui_html(), "text/html; charset=utf-8")
            if route in UI_SCRIPTS:
                return self._send(200, _ui_script(route), "text/javascript; charset=utf-8")
            if route.startswith("/api/review/"):
                return self._json(self.review.get(route, one))
            if route == "/api/state":
                return self._json(self.api.state())
            if route == "/api/runs":
                return self._json(self.api.runs(one("status"), one("card_id"),
                                                int(one("limit", "100"))))
            if route.startswith("/api/runs/"):
                return self._json(self.api.run_detail(route.rsplit("/", 1)[-1]))
            if route.startswith("/api/messages/"):
                return self._json(self.api.message(int(route.rsplit("/", 1)[-1])))
            if route == "/api/cards":
                return self._json(self.api.cards(one("db"), one("q"),
                                                 int(one("limit", "200"))))
            if route == "/api/cards/autocomplete":
                return self._json(self.api.cards_autocomplete(
                    one("q"), int(one("limit", "8"))))
            if route == "/api/plan":
                return self._json(self.api.plan())
            if route == "/api/cloud":
                return self._json(self.api.cloud())
            if route == "/api/glm":
                return self._json(self.api.glm())
            if route == "/api/models":
                return self._json(self.api.models())
            if route == "/api/settings":
                return self._json(self.api.settings())
            if route == "/api/setup":
                return self._json(self.api.setup())
            if route == "/api/guide":
                return self._json(self.api.guide())
            if route == "/api/quality":
                days = one("days", "7")
                return self._json(self.api.quality(int(days) if days.isdigit() else 7))
            if route == "/api/learning":
                return self._json(self.api.learning(one("module", "*")))
            if route == "/api/graph":
                # Потолок узлов задаёт UI: 3D-раскладка считается в браузере, и «сколько
                # тянет эта машина» знает только он. Финальный клэмп — внутри api.graph(),
                # здесь достаточно не упасть на "all"/мусоре от клиента (level=communities
                # игнорирует limit вовсе — см. api.graph).
                limit_raw = one("limit", "300")
                limit_val = int(limit_raw) if limit_raw.strip().isdigit() else 2500
                return self._json(self.api.graph(
                    limit_val, one("level", "files"), one("rel", "")))
            if route == "/api/graph/neighbors":
                # review-p4.md, находка #3: нечисловой hops/limit падал 500 — тот же
                # .isdigit()-гард, что уже есть тремя строками выше на /api/graph.
                hops_raw = one("hops", "1")
                limit_raw = one("limit", "50")
                hops_val = int(hops_raw) if hops_raw.strip().isdigit() else 1
                limit_val = int(limit_raw) if limit_raw.strip().isdigit() else 50
                return self._json(self.api.graph_neighbors(
                    one("node"), hops_val, limit_val,
                    one("level", "files"), one("rel", "")))
            if route.startswith("/api/graph/community/"):
                # id узла — "community:<label>", ":" в пути должен прийти %-энкоженным —
                # без unquote сюда попадает буквальный "community%3A1", а не "community:1".
                community_id = unquote(route.rsplit("/", 1)[-1])
                limit_raw = one("limit", "1000")
                limit_val = int(limit_raw) if limit_raw.strip().isdigit() else 25000
                return self._json(self.api.graph_community(
                    community_id, limit_val, one("level", "symbols"), one("rel", "")))
            if route == "/api/knowledge":
                return self._json(self.api.knowledge(
                    one("q"), one("kind", ""), int(one("page", "1")),
                    int(one("page_size", "50"))))
            if route.startswith("/api/notes/"):
                return self._json(self.api.notes(route.rsplit("/", 1)[-1]))
            if route == "/api/sessions":
                # review-p4.md, находка #3: нечисловой limit падал 500 — тот же гард.
                limit_raw = one("limit", "50")
                limit_val = int(limit_raw) if limit_raw.strip().isdigit() else 50
                return self._json(self.api.sessions(limit_val))
            if route.startswith("/api/sessions/"):
                return self._json(self.api.session_detail(route.rsplit("/", 1)[-1]))
            if route == "/api/statuses":
                return self._json(self.api.STATUSES)
            if route == "/api/ops":
                return self._json(self.api.ops_list())
            if route == "/api/bindings":
                return self._json(self.api.bindings())
            if route.startswith("/api/prompts/"):
                return self._json(self.api.prompt(unquote(route.rsplit("/", 1)[-1])))
            if route == "/api/queue":
                with self.api._store() as store:
                    return self._json(queue_control.status(
                        store, int(self.api.cfg.get("models.cloud_escalation.after_seconds", 7200)),
                        bool(self.api.cfg.get("models.cloud_escalation.enabled", False))))
            if route == "/api/batches":
                return self._json(self.api.batches())
            if route == "/api/estimate":
                return self._json(self.api.estimate(one("profile", "fast"),
                                                    int(one("count", "1")),
                                                    one("cloud_mode", "")))
            if route == "/api/events":
                if one("tail"):
                    return self._json(self.api.events_tail(int(one("tail"))))
                return self._json(self.api.events(int(one("since", "0"))))
            if route == "/api/events/unread":
                return self._json(self.api.events_unread(one("since", "")))
            if route == "/api/stream":
                # Без явного `since` лента начинается С ТЕКУЩЕГО момента, а не с нуля:
                # в журнале тысячи событий прошлых прогонов, и подписка «с начала»
                # вываливает их все разом, перемешанными по времени. Живая лента должна
                # показывать то, что происходит сейчас; история доступна через /api/events.
                raw_since = one("since", "")
                return self._stream(int(raw_since) if raw_since.strip()
                                    else self.api.latest_event_id())
            return self._json({"error": "нет такого маршрута"}, 404)
        except Exception as exc:                                    # noqa: BLE001
            # Шлюз — часть дев-контура: причина полезнее вежливого 500 без деталей.
            log(f"! {route}: {type(exc).__name__}: {exc}")
            return self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_POST(self) -> None:           # noqa: N802
        route = urlparse(self.path).path.rstrip("/")
        body = self._body()
        try:
            if route.startswith("/api/review/"):
                return self._json(self.review.post(route, body))
            if route == "/api/verdict":
                return self._json(self.api.verdict(
                    str(body.get("run_id") or ""), str(body.get("decision") or ""),
                    str(body.get("comment") or "")))
            if route == "/api/enqueue":
                return self._json(self.api.enqueue(
                    str(body.get("card_id") or ""), str(body.get("profile") or "fast"),
                    int(body.get("priority") or 9), str(body.get("cloud_mode") or "")))
            if route == "/api/tasks":
                return self._json(self.api.create_task(
                    str(body.get("title") or ""), str(body.get("body") or ""),
                    [str(x) for x in (body.get("links") or [])],
                    str(body.get("profile") or "fast"), str(body.get("cloud_mode") or "")))
            if route == "/api/glm":
                return self._json(self.api.set_glm(bool(body.get("on"))))
            if route == "/api/notes":
                return self._json(self.api.add_note(
                    str(body.get("card_id") or ""), str(body.get("note") or "")))
            if route == "/api/settings":
                return self._json(self.api.update_setting(
                    str(body.get("key") or ""), body.get("value")))
            if route == "/api/status":
                return self._json(self.api.set_status(
                    str(body.get("card_id") or ""), str(body.get("status") or "")))
            if route == "/api/ops":
                return self._json(self.api.run_op(str(body.get("name") or ""),
                                                  body.get("params") or {}))
            if route == "/api/cloud-ping":
                return self._json(self.api.cloud_ping(
                    str(body.get("provider") or ""), str(body.get("contour") or "primary")))
            if route == "/api/enqueue-batch":
                return self._json(self.api.enqueue_batch(
                    [str(x) for x in (body.get("card_ids") or [])],
                    str(body.get("profile") or "fast"), str(body.get("note") or ""),
                    int(body["start_at"]) if body.get("start_at") else None,
                    int(body["deadline"]) if body.get("deadline") else None,
                    cloud_mode=str(body.get("cloud_mode") or "")))
            if route == "/api/rubric":
                return self._json(self.api.rubric_decide(
                    int(body.get("id") or 0), str(body.get("status") or "")))
            if route == "/api/bindings":
                return self._json(self.api.set_binding(body))
            if route == "/api/prompts":
                return self._json(self.api.save_prompt(body))
            if route == "/api/queue/pause":
                with self.api._store() as store:
                    return self._json(queue_control.pause(
                        store, str(body.get("batch_id") or ""), "ui", str(body.get("reason") or "")))
            if route == "/api/queue/resume":
                with self.api._store() as store:
                    return self._json(queue_control.resume(
                        store, str(body.get("batch_id") or ""), bool(body.get("include_cancelled")),
                        bool(body.get("include_expired")), "ui"))
            if route == "/api/cancel":
                return self._json(self.api.cancel_queued(str(body.get("batch_id") or "")))
            if route == "/api/sessions":
                return self._json(self.api.open_session(str(body.get("title") or "")))
            if route.endswith("/close") and route.startswith("/api/sessions/"):
                session_id = route[len("/api/sessions/"):-len("/close")]
                return self._json(self.api.close_session(session_id))
            return self._json({"error": "нет такого маршрута"}, 404)
        except Exception as exc:                                    # noqa: BLE001
            log(f"! {route}: {type(exc).__name__}: {exc}")
            return self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    # ── SSE ──────────────────────────────────────────────────────────────────
    def _stream(self, since: int) -> None:
        """Живая лента событий. Heartbeat каждые 25 с — без него посредники и сам
        браузер рвут простаивающее соединение через 30–60 с (правило проекта для SSE)."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last_id, last_beat = since, time.time()
        try:
            while not _stopping.is_set():
                for event in self.api.events(last_id):
                    last_id = max(last_id, int(event["id"]))
                    payload = json.dumps(event, ensure_ascii=False, default=str)
                    self.wfile.write(f"id: {last_id}\ndata: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    last_beat = time.time()
                if time.time() - last_beat >= 25:
                    self.wfile.write(b":ping\n\n")
                    self.wfile.flush()
                    last_beat = time.time()
                time.sleep(1.0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return                       # вкладку закрыли — штатное завершение потока


def _ui_html() -> bytes:
    """UI читается с диска на каждый запрос: правка index.html видна по F5, без
    перезапуска сервиса. Файл небольшой, а цикл «поправил — обновил» важнее экономии
    на чтении. Если файла нет — подсистема всё равно должна отвечать, поэтому заглушка."""
    try:
        return UI_FILE.read_bytes()
    except OSError:
        return (b"<!doctype html><meta charset=utf-8>"
                b"<p>UI-\xd1\x84\xd0\xb0\xd0\xb9\xd0\xbb \xd0\xbd\xd0\xb5 \xd0\xbd\xd0\xb0"
                b"\xd0\xb9\xd0\xb4\xd0\xb5\xd0\xbd: infra/ai-council/ui/index.html")


def _ui_script(route: str) -> bytes:
    """Скрипты вкладки «Ревью» — тоже с диска на каждый запрос (правка видна по F5)."""
    try:
        return UI_SCRIPTS[route].read_bytes()
    except OSError:
        return f"console.warn('{route} not found');".encode("utf-8")


def serve(cfg, host: str, port: int) -> int:
    if host not in ("127.0.0.1", "localhost", "::1"):
        # §3: транскрипт и содержимое борда наружу не выставляются. Авторизации у шлюза
        # нет по устройству, поэтому единственная защита — отсутствие внешнего сокета.
        log(f"отказ: host={host}. Шлюз слушает только петлю (127.0.0.1) — в нём "
            f"полный транскрипт прогонов и борд, а авторизации нет.")
        return 1

    Handler.api = Api(cfg)
    Handler.review = ReviewApi(cfg)
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True

    def _stop(_signum, _frame):
        _stopping.set()
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log(f"AI Council UI: http://{host}:{port}")
    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        _stopping.set()
        httpd.server_close()
        log("шлюз остановлен")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Council — HTTP-шлюз и UI ревью")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()

    cfg = config_mod.load(strict=False)
    host = args.host or cfg.get("gateway.host", "127.0.0.1")
    port = args.port or int(cfg.get("gateway.port", 8790))
    mimetypes.init()
    return serve(cfg, host, port)


if __name__ == "__main__":
    sys.exit(main())
