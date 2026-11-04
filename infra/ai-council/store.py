#!/usr/bin/env python3
"""AI Council — слой хранилища (SQLite WAL). Только stdlib.

Канон схемы: schema.sql + docs/specs/ai-council.md §13.

БД — единственный канал связи между процессами консилиума (supervisor / council /
notion-sync / planner / gateway). Отсюда два инварианта, которые нельзя обходить:

1. Захват работы — только через claim_run(): BEGIN IMMEDIATE + UPDATE по status='queued'.
   Схема "SELECT ... WHERE status='queued'" затем "UPDATE" — гонка, несколько воркеров
   заберут одну запись (тот же антипаттерн, что для outbox в .claude/rules/00-antipatterns.md).
2. Модельный лок (§4, потолок 24 GB) — acquire_model_lock() с TTL, чтобы упавший воркер
   не оставил лок навсегда.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

import sys

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import COUNCIL_DB_REL, REPO_ROOT  # noqa: E402 — корень хоста (TAIBE_HOST_ROOT)

DB_PATH = REPO_ROOT / COUNCIL_DB_REL
INIT_ENV = "AI_COUNCIL_INIT_DB"


class CouncilDbMissing(RuntimeError):
    """Рабочей council.db нет, а создавать её молча нельзя."""


def ensure_db_allowed(path: Path) -> None:
    """Рабочая база (DB_PATH) создаётся только явно: env AI_COUNCIL_INIT_DB=1.

    Иначе процесс из копии слоя без TAIBE_HOST_ROOT создал бы рядом с собой пустую council.db и
    работал бы с ней вместо базы хоста: две живые базы, корпус пуст, прогоны теряются. Явные пути
    (тесты, --db) не трогаем — за них отвечает вызывающий.
    """
    if path.exists() or path.resolve() != DB_PATH.resolve():
        return
    if os.environ.get(INIT_ENV, "").strip() == "1":
        return
    raise CouncilDbMissing(
        f"нет базы консилиума {DB_PATH}. Хост задаёт TAIBE_HOST_ROOT "
        f"(сейчас {os.environ.get('TAIBE_HOST_ROOT') or 'не задан — хост = этот репозиторий'}). "
        f"Новая база — только явно: {INIT_ENV}=1 python3 infra/ai-council/store.py")
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"

SCHEMA_VERSION = 1
MODEL_LOCK = "ollama_large"


def now() -> int:
    return int(time.time())


def sha16(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:16]


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class Store:
    """Тонкая обёртка над sqlite3. Один экземпляр на процесс, не потокобезопасен
    между процессами по объекту — но безопасен по БД (WAL + транзакционные захваты)."""

    def __init__(self, path: Path | str = DB_PATH):
        self.path = Path(path)
        ensure_db_allowed(self.path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # isolation_level=None → управляем транзакциями руками (нужно для BEGIN IMMEDIATE)
        self.conn = sqlite3.connect(str(self.path), timeout=15.0, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA busy_timeout=15000")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self._migrate()

    # ── схема ────────────────────────────────────────────────────────────────
    # Колонки, добавленные после первой версии схемы. `CREATE TABLE IF NOT EXISTS`
    # существующую таблицу не меняет, поэтому новые поля добавляются здесь — идемпотентно,
    # по факту отсутствия в PRAGMA table_info.
    ADDED_COLUMNS = (
        # Окно запуска серии: не начинать раньше `not_before`, не начинать новые
        # карточки после `expires_at`. Проверяется в claim_run, а не в UI, — иначе
        # ограничение по времени было бы декларацией.
        ("runs", "not_before", "INTEGER"),
        ("runs", "expires_at", "INTEGER"),
        ("runs", "batch_id", "TEXT"),
        # v2/Ф1: @-упоминания из главной формы — JSON [card_id,...] на черновике
        # задачи. Живут на карточке, а не на прогоне: связи переживают прогоны.
        ("cards", "linked_card_ids", "TEXT"),
        # Отложенный повтор ревью (memory-guard): тот же смысл, что runs.not_before.
        ("review_runs", "not_before", "INTEGER"),
        # Облачная эскалация (cloud_escalation.py, §17.4): с какого момента задача ждёт
        # памяти, когда снова пробовать облако после отказа всех провайдеров, и итог
        # эскалации (провайдер, какие модели на что заменены, сколько ждала).
        ("runs", "mem_wait_since", "INTEGER"),
        ("runs", "cloud_retry_at", "INTEGER"),
        ("runs", "escalation", "TEXT"),
        ("review_runs", "mem_wait_since", "INTEGER"),
        ("review_runs", "cloud_retry_at", "INTEGER"),
        ("review_runs", "escalation", "TEXT"),
        # Режим «всё на GLM 5.x» (glm_mode.py, §17.6): 'glm5' — задача отмечена режимом при
        # постановке ИЛИ прошла в нём по тумблеру шапки (воркер ставит при захвате), чтобы
        # история показывала, какими моделями она сделана. NULL — обычный ростер профиля.
        ("runs", "cloud_mode", "TEXT"),
        # Дрейф M4 (council_infra.py): сколько раз прогон уже отложен из-за сбоя инфраструктуры локальных моделей.
        ("runs", "infra_deferrals", "INTEGER"),
    )

    def _migrate(self) -> None:
        self.conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        for table, column, decl in self.ADDED_COLUMNS:
            existing = {r["name"] for r in
                        self.conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if column not in existing:
                self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        cur = self.conn.execute("SELECT MAX(version) v FROM schema_version").fetchone()
        if cur["v"] is None:
            self.conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                (SCHEMA_VERSION, now()),
            )

    def close(self) -> None:
        try:
            self.conn.close()
        except sqlite3.Error:
            pass

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ── низкоуровневое ───────────────────────────────────────────────────────
    def q(self, sql: str, params: tuple = ()) -> list[dict]:
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def q1(self, sql: str, params: tuple = ()) -> dict | None:
        row = self.conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def x(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        return self.conn.execute(sql, params)

    # ── карточки ─────────────────────────────────────────────────────────────
    def upsert_card(self, card: dict) -> bool:
        """Возвращает True, если содержимое изменилось (значит карточку надо переработать)."""
        prev = self.q1("SELECT content_hash FROM cards WHERE card_id = ?", (card["card_id"],))
        changed = prev is None or prev["content_hash"] != card.get("content_hash")
        cols = (
            "card_id", "db", "title", "url", "status", "priority", "severity", "task_type",
            "source", "backlog_id", "modules", "tags", "half_baked", "parent_card_id",
            "subtask_ids", "report", "body", "comments", "content_hash", "notion_edited_at",
            "fetched_at", "linked_card_ids",
        )
        vals = [card.get(c) for c in cols]
        placeholders = ", ".join("?" for _ in cols)
        updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c != "card_id")
        self.x(
            f"INSERT INTO cards ({', '.join(cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT(card_id) DO UPDATE SET {updates}",
            tuple(vals),
        )
        return changed

    def open_cards(self, db: str | None = None, statuses: list[str] | None = None) -> list[dict]:
        sql, params = "SELECT * FROM cards WHERE 1=1", []
        if db:
            sql, params = sql + " AND db = ?", params + [db]
        if statuses:
            sql += " AND status IN (%s)" % ", ".join("?" for _ in statuses)
            params += statuses
        return self.q(sql + " ORDER BY db, status, title", tuple(params))

    def get_card(self, card_id: str) -> dict | None:
        return self.q1("SELECT * FROM cards WHERE card_id = ?", (card_id,))

    # ── очередь ──────────────────────────────────────────────────────────────
    def enqueue(self, card_id: str | None, track: str = "elaborate",
                profile: str = "fast", priority: int = 0,
                config_hash: str = "", git_sha: str = "", card_hash: str = "",
                dedupe: bool = True, not_before: int | None = None,
                expires_at: int | None = None, batch_id: str = "",
                cloud_mode: str = "") -> str | None:
        """Ставит прогон в очередь. dedupe=True → не плодит второй queued-прогон
        на ту же карточку и трек (иначе перезапуск supervisor'а дублирует очередь).
        cloud_mode='glm5' — все роли прогона на GLM 5.x (glm_mode.py)."""
        if dedupe and card_id:
            existing = self.q1(
                "SELECT id FROM runs WHERE card_id = ? AND track = ? "
                "AND status IN ('queued', 'running')",
                (card_id, track),
            )
            if existing:
                return None
        run_id = new_id("run")
        self.x(
            "INSERT INTO runs (id, card_id, track, profile, status, priority, "
            "config_hash, git_sha, card_hash, created_at, not_before, expires_at, batch_id, "
            "cloud_mode) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (run_id, card_id, track, profile, priority, config_hash, git_sha, card_hash,
             now(), not_before, expires_at, batch_id or None, cloud_mode or None),
        )
        self.event("run.queued", run_id, json.dumps({"card_id": card_id, "track": track}))
        return run_id

    def claim_run(self, worker: str, tracks: list[str] | None = None,
                  exclude_profiles: list[str] | None = None, route: str = "any") -> dict | None:
        """Атомарный захват. BEGIN IMMEDIATE берёт write-лок сразу — конкурирующий
        воркер получит SQLITE_BUSY и подождёт (busy_timeout), а не заберёт ту же строку.
        exclude_profiles — профили, заблокированные memory-guard: их прогоны остаются на
        своём месте в очереди, захват идёт дальше (queue_control.MemoryBlocks).
        route — какие прогоны: `any`; `local` — без отметки режима GLM 5.x (их берёт основной воркер, отмеченные
        ждут GLM во второй очереди); `glm` — только отмеченные (облачная полоса)."""
        track_filter, params = "", []
        if route == "local":
            track_filter = " AND COALESCE(cloud_mode, '') != 'glm5'"
        elif route == "glm":
            track_filter = " AND COALESCE(cloud_mode, '') = 'glm5'"
        if tracks:
            track_filter += " AND track IN (%s)" % ", ".join("?" for _ in tracks)
            params = list(tracks)
        if exclude_profiles:
            # Прогон режима GLM 5.x локальных L-моделей не грузит (локально только embed) —
            # блок памяти его профиля к нему не относится, ждать ему нечего.
            track_filter += (" AND (profile NOT IN (%s) OR COALESCE(cloud_mode, '') = 'glm5')"
                             % ", ".join("?" for _ in exclude_profiles))
            params += list(exclude_profiles)
        ts_now = now()
        # Просроченные снимаются ДО захвата: серия с окном «до 07:00» не должна
        # доедаться днём. Это делает ограничение по времени реальным, а не пометкой
        # в интерфейсе — воркер физически не возьмёт такую карточку.
        self.conn.execute(
            "UPDATE runs SET status='expired', outcome='окно запуска истекло', "
            "finished_at=? WHERE status='queued' AND expires_at IS NOT NULL "
            "AND expires_at < ?", (ts_now, ts_now))
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            row = self.conn.execute(
                "SELECT id FROM runs WHERE status = 'queued'" + track_filter +
                " AND (not_before IS NULL OR not_before <= ?)"
                " ORDER BY priority DESC, created_at LIMIT 1",
                tuple(params) + (ts_now,),
            ).fetchone()
            if row is None:
                self.conn.execute("COMMIT")
                return None
            ts = now()
            self.conn.execute(
                "UPDATE runs SET status='running', claimed_by=?, claimed_at=?, "
                "heartbeat_at=?, started_at=COALESCE(started_at, ?), attempts=attempts+1 "
                "WHERE id = ?",
                (worker, ts, ts, ts, row["id"]),
            )
            self.conn.execute("COMMIT")
        except sqlite3.Error:
            try:
                self.conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            return None
        return self.q1("SELECT * FROM runs WHERE id = ?", (row["id"],))

    def heartbeat(self, run_id: str) -> None:
        self.x("UPDATE runs SET heartbeat_at = ? WHERE id = ?", (now(), run_id))

    def reap_stale(self, ttl_seconds: int = 900) -> int:
        """Воркер упал (kill -9, OOM) — прогон завис в running навсегда. Возвращаем в очередь.
        Вызывается супервизором периодически; без этого очередь тихо деградирует."""
        cutoff = now() - ttl_seconds
        cur = self.x(
            "UPDATE runs SET status='queued', claimed_by=NULL, claimed_at=NULL "
            "WHERE status='running' AND COALESCE(heartbeat_at, claimed_at, 0) < ? "
            "AND attempts < 3",
            (cutoff,),
        )
        failed = self.x(
            "UPDATE runs SET status='failed', error='stale: превышен лимит попыток' "
            "WHERE status='running' AND COALESCE(heartbeat_at, claimed_at, 0) < ? "
            "AND attempts >= 3",
            (cutoff,),
        )
        return (cur.rowcount or 0) + (failed.rowcount or 0)

    def finish_run(self, run_id: str, status: str, outcome: str = "",
                   payload: dict | None = None, confidence: float | None = None,
                   readiness: float | None = None, error: str = "") -> None:
        started = self.q1("SELECT started_at FROM runs WHERE id = ?", (run_id,))
        wall = None
        if started and started["started_at"]:
            wall = (now() - started["started_at"]) * 1000
        self.x(
            "UPDATE runs SET status=?, outcome=?, payload=?, confidence=?, readiness=?, "
            "finished_at=?, wall_ms=?, error=? WHERE id = ?",
            (status, outcome, json.dumps(payload, ensure_ascii=False) if payload else None,
             confidence, readiness, now(), wall, error, run_id),
        )
        self.event(f"run.{status}", run_id, outcome)

    def clear_attempt(self, run_id: str) -> None:
        """Строки прошлой попытки того же прогона (предложения, рецензии, верификации). Транскрипт (messages) остаётся:
        он — улика того, почему попытку пришлось повторить."""
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            for table in ("reviews", "verifications", "proposals"):
                self.conn.execute(f"DELETE FROM {table} WHERE run_id = ?", (run_id,))
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

    def defer_run(self, run_id: str, not_before: int, why: str) -> None:
        """Дрейф M4: прогон обратно в очередь не раньше `not_before`, без сожжённой попытки, счётчик откладываний +1."""
        self.x("UPDATE runs SET status='queued', claimed_by=NULL, claimed_at=NULL, started_at=NULL, "
               "attempts=MAX(attempts-1, 0), not_before=?, error=?, "
               "infra_deferrals=COALESCE(infra_deferrals, 0)+1 WHERE id=?", (int(not_before), why[:500], run_id))
        self.event("run.deferred", run_id, why[:300])

    def queue_depth(self) -> dict:
        rows = self.q("SELECT status, COUNT(*) n FROM runs GROUP BY status")
        return {r["status"]: r["n"] for r in rows}

    # ── транскрипт ───────────────────────────────────────────────────────────
    def log_message(self, run_id: str, round_no: int, role: str, model: str,
                    prompt: str, response: str, ok: bool, ms: int,
                    tokens_in: int = 0, tokens_out: int = 0) -> None:
        self.x(
            "INSERT INTO messages (run_id, round, role, model, prompt_sha, prompt, response, "
            "ok, tokens_in, tokens_out, ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, round_no, role, model, sha16(prompt), prompt, response,
             1 if ok else 0, tokens_in, tokens_out, ms, now()),
        )

    # ── модельный лок (§4: не более одной L-модели резидентно) ───────────────
    def acquire_model_lock(self, holder: str, model: str, ttl: int = 1800) -> bool:
        ts = now()
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            cur = self.conn.execute(
                "SELECT holder, model, expires_at FROM locks WHERE name = ?", (MODEL_LOCK,)
            ).fetchone()
            if cur and cur["expires_at"] and cur["expires_at"] > ts and cur["holder"] != holder:
                self.conn.execute("COMMIT")
                return False
            self.conn.execute(
                "INSERT INTO locks (name, holder, model, acquired_at, expires_at) "
                "VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET "
                "holder=excluded.holder, model=excluded.model, "
                "acquired_at=excluded.acquired_at, expires_at=excluded.expires_at",
                (MODEL_LOCK, holder, model, ts, ts + ttl),
            )
            self.conn.execute("COMMIT")
            return True
        except sqlite3.Error:
            try:
                self.conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            return False

    def release_model_lock(self, holder: str) -> None:
        self.x("DELETE FROM locks WHERE name = ? AND holder = ?", (MODEL_LOCK, holder))

    def current_model_lock(self) -> dict | None:
        row = self.q1("SELECT * FROM locks WHERE name = ?", (MODEL_LOCK,))
        if row and row.get("expires_at") and row["expires_at"] <= now():
            return None
        return row

    # ── аудит записи в Notion ────────────────────────────────────────────────
    def log_notion_write(self, run_id: str, page_id: str, op: str, field: str = "",
                         before: str = "", after: str = "", ok: bool = True,
                         dry_run: bool = False, error: str = "") -> None:
        self.x(
            "INSERT INTO notion_writes (run_id, page_id, op, field, before, after, ok, "
            "dry_run, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (run_id, page_id, op, field, before, after, 1 if ok else 0,
             1 if dry_run else 0, error, now()),
        )

    def remember_created_page(self, child_key: str, page_id: str, parent_card_id: str,
                              db: str, title: str, run_id: str) -> None:
        self.x(
            "INSERT OR IGNORE INTO created_pages "
            "(child_key, page_id, parent_card_id, db, title, run_id, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (child_key, page_id, parent_card_id, db, title, run_id, now()),
        )

    def find_created_page(self, child_key: str) -> dict | None:
        return self.q1("SELECT * FROM created_pages WHERE child_key = ?", (child_key,))

    # ── события (SSE в gateway) ──────────────────────────────────────────────
    # ── указания владельца к карточке ────────────────────────────────────────
    def card_notes(self, card_id: str, active_only: bool = True) -> list[dict]:
        where = "AND active = 1" if active_only else ""
        return self.q(
            f"SELECT id, note, author, active, created_at FROM card_notes "
            f"WHERE card_id = ? {where} ORDER BY id DESC", (card_id,))

    def add_card_note(self, card_id: str, note: str, author: str = "owner") -> int:
        """Новое указание гасит предыдущие: в капсулу должно уходить актуальное мнение
        владельца, а не склейка всех, что он когда-либо писал. Старые не удаляются —
        по ним объясняется, почему прошлый прогон дал именно такой результат."""
        self.x("UPDATE card_notes SET active = 0 WHERE card_id = ?", (card_id,))
        cur = self.x(
            "INSERT INTO card_notes (card_id, note, author, active, created_at) "
            "VALUES (?,?,?,1,?)", (card_id, note.strip(), author, now()))
        self.event("note.added", card_id, note.strip()[:120])
        return int(cur.lastrowid or 0)

    def active_note_text(self, card_id: str) -> str:
        row = self.q1(
            "SELECT note FROM card_notes WHERE card_id = ? AND active = 1 "
            "ORDER BY id DESC LIMIT 1", (card_id,))
        return (row or {}).get("note") or ""

    def event(self, kind: str, ref: str = "", detail: str = "") -> None:
        self.x(
            "INSERT INTO events (kind, ref, detail, created_at) VALUES (?,?,?,?)",
            (kind, ref, detail, now()),
        )

    def events_since(self, last_id: int, limit: int = 200) -> list[dict]:
        return self.q(
            "SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?", (last_id, limit)
        )

    def prune_events(self, keep: int = 5000) -> None:
        self.x(
            "DELETE FROM events WHERE id < (SELECT MAX(id) - ? FROM events)", (keep,)
        )

    # ── сессии (P4/Ф2: рабочая сессия владельца — план §P4, решение B) ────────
    # Итоговый контекст принадлежит СЕССИИ, не карточке. Свёртка (LLM-вызов,
    # запись в corpus) — не дело store.py (только stdlib/SQLite); это оркестрирует
    # вызывающий код (gateway.Api / context_service), store даёт лишь примитивы.
    def open_session(self, title: str = "") -> dict:
        """Не закрывает предыдущую открытую сама — решает вызывающий: открытие
        новой при живой прежней должно явно закрыть её (со свёрткой), а не
        оставить две сессии `open` одновременно молча.

        Не использовать напрямую из HTTP-хендлера — check-then-act между этим
        методом и `get_open_session()` гонится (review-p4.md, находка #1):
        `open_session_exclusive()` ниже закрывает разрыв. Метод оставлен ради
        selftest-фикстур, которым заведомо не нужна авто-логика закрытия прежней."""
        session_id = new_id("sess")
        self.x(
            "INSERT INTO sessions (id, title, opened_at, status) VALUES (?,?,?,'open')",
            (session_id, title.strip(), now()),
        )
        self.event("session.opened", session_id, title.strip()[:120])
        return self.q1("SELECT * FROM sessions WHERE id = ?", (session_id,))

    def open_session_exclusive(self, title: str = "") -> tuple[dict, dict | None]:
        """Атомарный «закрыть прежнюю открытую (если есть) + открыть новую» —
        одна транзакция вместо трёх отдельных вызовов (SELECT прежней → закрыть →
        INSERT новой), которые в `Api.open_session()` гонялись на двух
        параллельных HTTP-запросах: оба видели «нет открытой» и оба вставляли
        свою — на выходе две одновременно `status='open'` строки без механизма
        самоизлечения (review-p4.md, находка #1, воспроизведено `threading.Barrier`
        на живом гейтвее). Свёртка прежней сессии (LLM-вызов) сюда не входит —
        она небыстрая и не должна держать write-лок; вызывающий делает её ПОСЛЕ,
        используя возвращённую `prior`."""
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            prior_row = self.conn.execute(
                "SELECT * FROM sessions WHERE status = 'open' "
                "ORDER BY opened_at DESC LIMIT 1").fetchone()
            prior = dict(prior_row) if prior_row else None
            if prior:
                self.conn.execute(
                    "UPDATE sessions SET status='closed', closed_at=? WHERE id=?",
                    (now(), prior["id"]))
            session_id = new_id("sess")
            self.conn.execute(
                "INSERT INTO sessions (id, title, opened_at, status) VALUES (?,?,?,'open')",
                (session_id, title.strip(), now()))
            self.conn.execute("COMMIT")
        except sqlite3.Error:
            try:
                self.conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        if prior:
            self.event("session.closed", prior["id"], "")
        self.event("session.opened", session_id, title.strip()[:120])
        return self.q1("SELECT * FROM sessions WHERE id = ?", (session_id,)), prior

    def get_open_session(self) -> dict | None:
        return self.q1("SELECT * FROM sessions WHERE status = 'open' "
                       "ORDER BY opened_at DESC LIMIT 1")

    def get_session(self, session_id: str) -> dict | None:
        return self.q1("SELECT * FROM sessions WHERE id = ?", (session_id,))

    def latest_closed_session(self) -> dict | None:
        return self.q1("SELECT * FROM sessions WHERE status = 'closed' "
                       "ORDER BY closed_at DESC LIMIT 1")

    def sessions_list(self, limit: int = 50) -> list[dict]:
        return self.q("SELECT * FROM sessions ORDER BY opened_at DESC LIMIT ?", (limit,))

    def close_session_if_open(self, session_id: str) -> bool:
        """Атомарный флип статуса — ДО того как вызывающий код читает session_runs
        для свёртки. Гонка с add_session_run_if_open закрыта этим порядком: прогон
        либо успевает прикрепиться раньше COMMIT ниже (и тогда попадёт в свёртку —
        она читает session_runs уже после этого коммита), либо BEGIN IMMEDIATE здесь
        забирает write-лок первым и прогон увидит status='closed' и не прикрепится
        вовсе. Третьего состояния («прикрепился, но свёртка его не увидела») нет —
        тот же приём, что claim_run/acquire_model_lock выше."""
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            row = self.conn.execute(
                "SELECT status FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if row is None or row["status"] != "open":
                self.conn.execute("COMMIT")
                return False
            self.conn.execute(
                "UPDATE sessions SET status='closed', closed_at=? WHERE id=?",
                (now(), session_id))
            self.conn.execute("COMMIT")
        except sqlite3.Error:
            try:
                self.conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            return False
        self.event("session.closed", session_id, "")
        return True

    def set_session_summary(self, session_id: str, summary: str, model: str,
                            tokens: int, source_run_id: str = "") -> None:
        self.x(
            "UPDATE sessions SET summary=?, summary_model=?, summary_tokens=? WHERE id=?",
            (summary, model, tokens, session_id),
        )
        self.x(
            "INSERT INTO session_contexts (session_id, summary, version, source_run_id, "
            "updated_at) VALUES (?,?,1,?,?) ON CONFLICT(session_id) DO UPDATE SET "
            "summary=excluded.summary, version=session_contexts.version+1, "
            "source_run_id=excluded.source_run_id, updated_at=excluded.updated_at",
            (session_id, summary, source_run_id, now()),
        )

    def add_session_run_if_open(self, run_id: str) -> str | None:
        """Атомарно: есть открытая сессия — прогон в неё (INSERT OR IGNORE, дубли
        безопасны), иначе no-op. Та же гарантия в паре с close_session_if_open —
        см. его docstring."""
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            row = self.conn.execute(
                "SELECT id FROM sessions WHERE status = 'open' "
                "ORDER BY opened_at DESC LIMIT 1").fetchone()
            if row is None:
                self.conn.execute("COMMIT")
                return None
            self.conn.execute(
                "INSERT OR IGNORE INTO session_runs (session_id, run_id, added_at) "
                "VALUES (?,?,?)", (row["id"], run_id, now()))
            self.conn.execute("COMMIT")
            return row["id"]
        except sqlite3.Error:
            try:
                self.conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            return None

    def session_runs(self, session_id: str) -> list[dict]:
        """Прогоны сессии с деталями карточки — вход свёртки закрытия."""
        return self.q(
            "SELECT r.id, r.card_id, r.status, r.outcome, r.payload, r.confidence, "
            "r.readiness, c.title, c.db, c.severity, c.priority "
            "FROM session_runs sr JOIN runs r ON r.id = sr.run_id "
            "LEFT JOIN cards c ON c.card_id = r.card_id "
            "WHERE sr.session_id = ? ORDER BY sr.added_at", (session_id,))


def git_sha() -> str:
    """HEAD без запуска git (git может отсутствовать в PATH у демона)."""
    try:
        head = (REPO_ROOT / ".git/HEAD").read_text(encoding="utf-8").strip()
        if head.startswith("ref: "):
            ref = (REPO_ROOT / ".git" / head[5:]).read_text(encoding="utf-8").strip()
            return ref[:12]
        return head[:12]
    except OSError:
        return ""


if __name__ == "__main__":
    # Диагностика: python3 infra/ai-council/store.py
    with Store() as s:
        print("db:", s.path)
        print("schema_version:", s.q1("SELECT MAX(version) v FROM schema_version")["v"])
        print("cards:", s.q1("SELECT COUNT(*) n FROM cards")["n"])
        print("queue:", s.queue_depth() or "пусто")
        print("model lock:", s.current_model_lock() or "свободен")
        print("git:", git_sha())
