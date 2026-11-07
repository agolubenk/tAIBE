#!/usr/bin/env python3
"""AI Council — хранилище ревью-оркестрации поверх store.Store. Только stdlib.

Таблицы review_* (schema.sql). Тот же инвариант, что у очереди проработок: захват
прогона — только BEGIN IMMEDIATE + UPDATE по status='queued' (claim), иначе два воркера
разберут одну карточку.

Встроенные агенты/профили/доски засеваются при первом обращении (seed) и дальше
принадлежат владельцу: правки из UI не перетираются засевом, «сбросить к стандартным»
— явная операция.
"""
from __future__ import annotations

import json
import sqlite3

import review_catalog as cat
from store import Store, new_id, now


def _j(raw, default=None):
    if raw in (None, ""):
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


def _dump(value) -> str:
    return json.dumps(value, ensure_ascii=False)


class ReviewStore:
    def __init__(self, store: Store):
        self.s = store
        self.seed()

    # ── засев ────────────────────────────────────────────────────────────────
    def seed(self) -> None:
        ts = now()
        for agent in cat.BUILTIN_AGENTS:
            key = agent["key"]
            spec = cat.validate_agent(key, {k: v for k, v in agent.items() if k != "key"})
            self.s.x("INSERT OR IGNORE INTO review_agents (key, spec, builtin, updated_at) "
                     "VALUES (?, ?, 1, ?)", (key, _dump(spec), ts))
            self._upgrade_builtin(key, spec, ts)
        self._seed_profiles()
        for board, spec in cat.DEFAULT_BOARDS.items():
            self.s.x("INSERT OR IGNORE INTO review_boards (board, spec, updated_at) "
                     "VALUES (?, ?, ?)", (board, _dump(spec), ts))

    def _upgrade_builtin(self, key: str, spec: dict, ts: int) -> None:
        """Неправленая строка встроенного агента (совпадает с одним из прежних стандартов) —
        до нового стандарта. Сравнить-и-заменить одним UPDATE по точному старому тексту:
        seed() зовут UI, воркер, MCP и CLI, и правка владельца между чтением и записью иначе
        была бы перетёрта. Правленую строку не трогаем — её вернёт только явный сброс."""
        row = self.s.q1("SELECT spec FROM review_agents WHERE key = ? AND builtin = 1", (key,))
        if not row:
            return
        current = _j(row["spec"], {})
        if cat.spec_hash(current) == cat.spec_hash(spec):
            return
        if cat.spec_hash(current) in cat.PREVIOUS_DEFAULT_HASHES.get(key, set()):
            self.s.x("UPDATE review_agents SET spec = ?, updated_at = ? WHERE key = ? AND spec = ?",
                     (_dump(spec), ts, key, row["spec"]))

    def _seed_profiles(self) -> None:
        """Профили по умолчанию — один раз по имени. Реестр засеянных — в review_settings
        (SEEDED_KEY, мимо settings(): тот фильтрует неизвестные ключи), чтобы удалённый или
        переименованный владельцем профиль не возвращался. Установка без реестра (до §17.5)
        считает засеянными все прежние профили по умолчанию — первые четыре."""
        keys = self.agent_keys()
        if not self.s.q1("SELECT 1 FROM review_profiles LIMIT 1"):
            for prof in cat.DEFAULT_PROFILES[:4]:
                self.save_profile(None, prof["name"], prof["spec"], keys,
                                  is_default=prof["is_default"])
        row = self.s.q1("SELECT value FROM review_settings WHERE key = ?", (cat.SEEDED_KEY,))
        seeded = set(_j(row["value"], []) if row else [p["name"] for p in cat.DEFAULT_PROFILES[:4]])
        names = {r["name"] for r in self.s.q("SELECT name FROM review_profiles")}
        for prof in cat.DEFAULT_PROFILES:
            if prof["name"] in seeded:
                continue
            if prof["name"] not in names:
                self.save_profile(None, prof["name"], prof["spec"], keys, is_default=False)
            seeded.add(prof["name"])
        if not row or set(_j(row["value"], [])) != seeded:
            self.s.x("INSERT INTO review_settings (key, value, updated_at) VALUES (?,?,?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                     (cat.SEEDED_KEY, _dump(sorted(seeded)), now()))

    def reset_builtin_agents(self) -> int:
        ts, n = now(), 0
        for agent in cat.BUILTIN_AGENTS:
            spec = cat.validate_agent(agent["key"], {k: v for k, v in agent.items() if k != "key"})
            self.s.x("INSERT INTO review_agents (key, spec, builtin, updated_at) VALUES (?,?,1,?) "
                     "ON CONFLICT(key) DO UPDATE SET spec=excluded.spec, updated_at=excluded.updated_at",
                     (agent["key"], _dump(spec), ts))
            n += 1
        return n

    # ── настройки ────────────────────────────────────────────────────────────
    def settings(self) -> dict:
        out = dict(cat.DEFAULT_SETTINGS)
        for row in self.s.q("SELECT key, value FROM review_settings"):
            if row["key"] in out:
                out[row["key"]] = _j(row["value"], out[row["key"]])
        return out

    def set_setting(self, key: str, value) -> dict:
        if key not in cat.DEFAULT_SETTINGS:
            raise cat.ValidationError(f"нет такой настройки ревью: {key}")
        default = cat.DEFAULT_SETTINGS[key]
        if isinstance(default, bool):
            value = bool(value)
        elif isinstance(default, int):
            value = int(value)
            if key == "max_num_ctx":
                value = max(2048, min(value, 262144))
            if key == "max_wall_seconds":
                value = max(120, min(value, 6 * 3600))
        else:
            value = str(value or "").strip()[:120]
        self.s.x("INSERT INTO review_settings (key, value, updated_at) VALUES (?,?,?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                 (key, _dump(value), now()))
        return self.settings()

    # ── агенты ───────────────────────────────────────────────────────────────
    def agents(self, enabled_only: bool = False) -> list[dict]:
        out = []
        for row in self.s.q("SELECT * FROM review_agents ORDER BY builtin DESC, key"):
            spec = _j(row["spec"], {})
            if enabled_only and spec.get("enabled") is False:
                continue
            out.append({"key": row["key"], "builtin": bool(row["builtin"]),
                        "updated_at": row["updated_at"], **spec})
        return out

    def agent(self, key: str) -> dict | None:
        row = self.s.q1("SELECT * FROM review_agents WHERE key = ?", (key,))
        if not row:
            return None
        return {"key": row["key"], "builtin": bool(row["builtin"]), **_j(row["spec"], {})}

    def agent_keys(self) -> set[str]:
        return {r["key"] for r in self.s.q("SELECT key FROM review_agents")}

    def save_agent(self, key: str, spec: dict) -> dict:
        clean = cat.validate_agent(key, spec)
        self.s.x("INSERT INTO review_agents (key, spec, builtin, updated_at) VALUES (?,?,0,?) "
                 "ON CONFLICT(key) DO UPDATE SET spec=excluded.spec, updated_at=excluded.updated_at",
                 (key, _dump(clean), now()))
        return self.agent(key)

    def delete_agent(self, key: str) -> None:
        row = self.s.q1("SELECT builtin FROM review_agents WHERE key = ?", (key,))
        if not row:
            raise cat.ValidationError(f"агента {key} нет")
        if row["builtin"]:
            raise cat.ValidationError("встроенного агента нельзя удалить — выключите его")
        used = [p["name"] for p in self.profiles()
                if key in p["spec"].get("agents", []) or key in (p["spec"].get("judge"),
                                                                 p["spec"].get("adversary"))]
        if used:
            raise cat.ValidationError(f"агент используется в профилях: {', '.join(used)}")
        self.s.x("DELETE FROM review_agents WHERE key = ?", (key,))

    # ── профили ──────────────────────────────────────────────────────────────
    def _profile_row(self, row: dict) -> dict:
        return {"id": row["id"], "name": row["name"], "is_default": bool(row["is_default"]),
                "archived": bool(row["archived"]), "version": row["version"],
                "updated_at": row["updated_at"], "spec": _j(row["spec"], {})}

    def profiles(self, include_archived: bool = False) -> list[dict]:
        where = "" if include_archived else "WHERE archived = 0"
        return [self._profile_row(r) for r in
                self.s.q(f"SELECT * FROM review_profiles {where} ORDER BY is_default DESC, name")]

    def profile(self, ref: str | None) -> dict | None:
        if ref:
            row = self.s.q1("SELECT * FROM review_profiles WHERE id = ? OR name = ?", (ref, ref))
        else:
            row = self.s.q1("SELECT * FROM review_profiles WHERE is_default = 1 AND archived = 0 "
                            "LIMIT 1") or self.s.q1("SELECT * FROM review_profiles WHERE archived = 0 "
                                                     "ORDER BY created_at LIMIT 1")
        return self._profile_row(row) if row else None

    def save_profile(self, profile_id: str | None, name: str, spec: dict,
                     agent_keys: set[str] | None = None, is_default: bool | None = None) -> dict:
        name = (name or "").strip()[:120]
        if not name:
            raise cat.ValidationError("у профиля должно быть название")
        clean = cat.validate_profile(spec, agent_keys or self.agent_keys())
        ts = now()
        clash = self.s.q1("SELECT id FROM review_profiles WHERE name = ? AND id != ? AND archived = 0",
                          (name, profile_id or ""))
        if clash:
            raise cat.ValidationError(f"профиль «{name}» уже есть")
        if profile_id:
            row = self.s.q1("SELECT version FROM review_profiles WHERE id = ?", (profile_id,))
            if not row:
                raise cat.ValidationError(f"профиля {profile_id} нет")
            version = row["version"] + 1
            self.s.x("UPDATE review_profiles SET name=?, spec=?, version=?, updated_at=? WHERE id=?",
                     (name, _dump(clean), version, ts, profile_id))
        else:
            profile_id, version = new_id("rp"), 1
            self.s.x("INSERT INTO review_profiles (id, name, spec, version, created_at, updated_at) "
                     "VALUES (?,?,?,?,?,?)", (profile_id, name, _dump(clean), version, ts, ts))
        self.s.x("INSERT OR REPLACE INTO review_profile_versions (profile_id, version, spec, saved_at) "
                 "VALUES (?,?,?,?)", (profile_id, version, _dump(clean), ts))
        if is_default:
            self.s.x("UPDATE review_profiles SET is_default = (id = ?)", (profile_id,))
        return self.profile(profile_id)

    def set_default_profile(self, profile_id: str) -> None:
        if not self.s.q1("SELECT 1 FROM review_profiles WHERE id = ? AND archived = 0", (profile_id,)):
            raise cat.ValidationError("профиль не найден")
        self.s.x("UPDATE review_profiles SET is_default = (id = ?)", (profile_id,))

    def archive_profile(self, profile_id: str) -> None:
        row = self.s.q1("SELECT is_default FROM review_profiles WHERE id = ?", (profile_id,))
        if not row:
            raise cat.ValidationError("профиль не найден")
        if row["is_default"]:
            raise cat.ValidationError("профиль по умолчанию нельзя архивировать — сначала назначьте другой")
        self.s.x("UPDATE review_profiles SET archived = 1, updated_at = ? WHERE id = ?", (now(), profile_id))

    def profile_versions(self, profile_id: str) -> list[dict]:
        return [{"version": r["version"], "saved_at": r["saved_at"], "spec": _j(r["spec"], {})}
                for r in self.s.q("SELECT * FROM review_profile_versions WHERE profile_id = ? "
                                  "ORDER BY version DESC LIMIT 20", (profile_id,))]

    # ── доски ────────────────────────────────────────────────────────────────
    def boards(self) -> dict:
        out = {b: dict(cat.DEFAULT_BOARDS[b]) for b in cat.BOARDS}
        for row in self.s.q("SELECT * FROM review_boards"):
            if row["board"] in out:
                out[row["board"]] = {**out[row["board"]], **_j(row["spec"], {})}
        return out

    def save_board(self, board: str, spec: dict, statuses: list[str] | None = None) -> dict:
        clean = cat.validate_board(board, spec, statuses)
        if clean["profile_id"] and not self.profile(clean["profile_id"]):
            raise cat.ValidationError("профиль доски не найден")
        self.s.x("INSERT INTO review_boards (board, spec, updated_at) VALUES (?,?,?) "
                 "ON CONFLICT(board) DO UPDATE SET spec=excluded.spec, updated_at=excluded.updated_at",
                 (board, _dump(clean), now()))
        return self.boards()[board]

    # ── очередь карточек ─────────────────────────────────────────────────────
    CARD_COLS = ("card_id", "board", "title", "url", "status", "priority", "severity",
                 "task_type", "backlog_id", "modules", "tags", "half_baked", "report", "body",
                 "comments", "review_hash", "notion_edited_at", "origin", "ticket", "board_task_id")

    def upsert_card(self, card: dict) -> None:
        ts = now()
        prev = self.s.q1("SELECT in_queue FROM review_cards WHERE card_id = ?", (card["card_id"],))
        card = {**card, "half_baked": 1 if card.get("half_baked") else 0}
        vals = [card.get(c) for c in self.CARD_COLS]
        if prev is None:
            self.s.x(f"INSERT INTO review_cards ({', '.join(self.CARD_COLS)}, in_queue, first_seen_at, "
                     f"last_seen_at, fetched_at) VALUES ({', '.join('?' for _ in self.CARD_COLS)}, 1, ?, ?, ?)",
                     tuple(vals) + (ts, ts, ts))
            return
        sets = ", ".join(f"{c}=?" for c in self.CARD_COLS if c != "card_id")
        # Возврат в очередь после ухода = новый цикл ревью: first_seen_at сдвигается.
        reentry = ", first_seen_at=?" if not prev["in_queue"] else ""
        params = vals[1:] + [ts, ts] + ([ts] if reentry else []) + [card["card_id"]]
        self.s.x(f"UPDATE review_cards SET {sets}, in_queue=1, last_seen_at=?, fetched_at=?{reentry} "
                 f"WHERE card_id = ?", tuple(params))

    def mark_left_queue(self, board: str, seen_ids: set[str]) -> int:
        rows = self.s.q("SELECT card_id FROM review_cards WHERE board = ? AND in_queue = 1", (board,))
        gone = [r["card_id"] for r in rows if r["card_id"] not in seen_ids]
        for card_id in gone:
            self.s.x("UPDATE review_cards SET in_queue = 0 WHERE card_id = ?", (card_id,))
        return len(gone)

    def card(self, card_id: str) -> dict | None:
        return self.s.q1("SELECT * FROM review_cards WHERE card_id = ?", (card_id,))

    def card_by_task(self, task_id: str) -> dict | None:
        return self.s.q1("SELECT * FROM review_cards WHERE board_task_id = ?", (task_id,))

    def find_card(self, ref: str) -> dict | None:
        """По card_id, ключу t-boards (OPS-26), id t-boards, Backlog ID, затем по части названия. Снимок Notion
        (origin IS NULL) ищется только по точному card_id: по ключу и названию — карточки t-boards."""
        ref = (ref or "").strip()
        if not ref:
            return None
        return self.card(ref) or self.s.q1(
            "SELECT * FROM review_cards WHERE origin = 'tboards' AND (ticket = ? OR board_task_id = ? "
            "OR backlog_id = ? COLLATE NOCASE) ORDER BY in_queue DESC LIMIT 1", (ref.upper(), ref, ref)) \
            or self.s.q1("SELECT * FROM review_cards WHERE origin = 'tboards' AND title LIKE ? "
                         "ORDER BY in_queue DESC LIMIT 1", (f"%{ref}%",))

    def queue(self, board: str = "", include_left: bool = False) -> list[dict]:
        sql, params = "SELECT * FROM review_cards WHERE 1=1", []
        if not include_left:
            sql += " AND in_queue = 1"
        if board:
            sql, params = sql + " AND board = ?", params + [board]
        sev = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 " \
              "WHEN 'low' THEN 3 ELSE 4 END"
        rows = self.s.q(sql + f" ORDER BY board = 'tasks', {sev}, priority, first_seen_at", tuple(params))
        last = self.latest_runs([r["card_id"] for r in rows])
        for r in rows:
            r["last_run"] = last.get(r["card_id"])
        return rows

    # ── прогоны ──────────────────────────────────────────────────────────────
    def latest_runs(self, card_ids: list[str]) -> dict:
        if not card_ids:
            return {}
        out: dict = {}
        for i in range(0, len(card_ids), 400):
            chunk = card_ids[i:i + 400]
            marks = ", ".join("?" for _ in chunk)
            for r in self.s.q(
                    f"SELECT id, card_id, status, verdict, confidence, transition_state, "
                    f"transition_target, card_hash, created_at, finished_at, profile_name, method "
                    f"FROM review_runs WHERE card_id IN ({marks}) ORDER BY created_at", tuple(chunk)):
                out[r["card_id"]] = r                   # последний по времени перезапишет
        return out

    def active_run(self, card_id: str) -> dict | None:
        return self.s.q1("SELECT id, status FROM review_runs WHERE card_id = ? "
                         "AND status IN ('queued', 'running') LIMIT 1", (card_id,))

    def enqueue(self, card: dict, profile: dict, requested_by: str, request: dict,
                priority: int = 5) -> str:
        run_id = new_id("rv")
        self.s.x(
            "INSERT INTO review_runs (id, card_id, board, card_title, card_hash, status, priority, "
            "requested_by, profile_id, profile_name, method, request, created_at) "
            "VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?,?)",
            (run_id, card["card_id"], card["board"], card.get("title") or "",
             card.get("review_hash") or "", priority, requested_by, profile["id"], profile["name"],
             request.get("method") or profile["spec"]["method"], _dump(request), now()))
        self.s.event("review.queued", run_id, _dump({"card_id": card["card_id"],
                                                     "title": (card.get("title") or "")[:120]}))
        return run_id

    def claim(self, worker: str, exclude_profiles: list[str] | None = None, route: str = "any") -> dict | None:
        """route: `any`; `local` — без отметки GLM 5.x в запросе; `glm` — только отмеченные (как Store.claim_run)."""
        extra, params = "", [now()]
        if route in ("local", "glm"):
            from glm_mode import REVIEW_REQUESTED_SQL as glm_sql
            extra = f" AND {'NOT ' if route == 'local' else ''}({glm_sql})"
        if exclude_profiles:   # ревью с отметкой GLM 5.x L-моделей не грузит — блок памяти не про него
            from glm_mode import REVIEW_REQUESTED_SQL as glm
            extra += f" AND (COALESCE(profile_id, '') NOT IN ({', '.join('?' for _ in exclude_profiles)}) OR {glm})"
            params += list(exclude_profiles)
        try:
            self.s.conn.execute("BEGIN IMMEDIATE")
            row = self.s.conn.execute(
                "SELECT id FROM review_runs WHERE status = 'queued' "
                "AND (not_before IS NULL OR not_before <= ?)" + extra +
                " ORDER BY priority DESC, created_at LIMIT 1", tuple(params)).fetchone()
            if row is None:
                self.s.conn.execute("COMMIT")
                return None
            ts = now()
            self.s.conn.execute(
                "UPDATE review_runs SET status='running', claimed_by=?, heartbeat_at=?, "
                "started_at=COALESCE(started_at, ?), attempts=attempts+1 WHERE id = ?",
                (worker, ts, ts, row["id"]))
            self.s.conn.execute("COMMIT")
        except sqlite3.Error:
            try:
                self.s.conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            return None
        self.s.event("review.running", row["id"], "")
        return self.run(row["id"])

    def heartbeat(self, run_id: str) -> bool:
        """True — продолжать; False — владелец попросил отмену."""
        self.s.x("UPDATE review_runs SET heartbeat_at = ? WHERE id = ?", (now(), run_id))
        row = self.s.q1("SELECT cancel_requested FROM review_runs WHERE id = ?", (run_id,))
        return not (row and row["cancel_requested"])

    def reap_stale(self, ttl_seconds: int = 2400) -> int:
        cutoff = now() - ttl_seconds
        back = self.s.x("UPDATE review_runs SET status='queued', claimed_by=NULL WHERE status='running' "
                        "AND COALESCE(heartbeat_at, started_at, 0) < ? AND attempts < 2", (cutoff,))
        dead = self.s.x("UPDATE review_runs SET status='failed', error='stale: воркер пропал дважды', "
                        "finished_at=? WHERE status='running' AND COALESCE(heartbeat_at, started_at, 0) < ? "
                        "AND attempts >= 2", (now(), cutoff))
        return (back.rowcount or 0) + (dead.rowcount or 0)

    def release(self, run_id: str, why: str = "", not_before: int | None = None) -> None:
        """На то же место без сожжённой попытки и транскрипта: memory-guard или окно GLM 5.x (§17.6)."""
        self.s.x("DELETE FROM review_steps WHERE run_id = ?", (run_id,))
        self.s.x("UPDATE review_runs SET status='queued', claimed_by=NULL, started_at=NULL, attempts="
                 "MAX(attempts-1, 0), not_before=?, error=? WHERE id = ?", (not_before, why[:500], run_id))

    def defer(self, run_id: str, delay: int, why: str) -> None:
        """Отложенный повтор (memory-guard). Частичный транскрипт сносится: повтор пишет
        свой, и смешивать два захода в одном прогоне — значит врать в аудите."""
        self.s.x("DELETE FROM review_steps WHERE run_id = ?", (run_id,))
        self.s.x("UPDATE review_runs SET status='queued', claimed_by=NULL, not_before=?, error=? "
                 "WHERE id = ?", (now() + delay, why[:500], run_id))
        self.s.event("memory.deferred", run_id, why[:300])

    def save_snapshot(self, run_id: str, snapshot: dict) -> None:
        self.s.x("UPDATE review_runs SET snapshot = ? WHERE id = ?", (_dump(snapshot), run_id))

    def finish(self, run_id: str, status: str, verdict: str = "", confidence: float | None = None,
               summary: str = "", result: dict | None = None, error: str = "") -> None:
        row = self.s.q1("SELECT started_at FROM review_runs WHERE id = ?", (run_id,))
        wall = (now() - row["started_at"]) * 1000 if row and row["started_at"] else None
        self.s.x("UPDATE review_runs SET status=?, verdict=?, confidence=?, summary=?, result=?, "
                 "error=?, finished_at=?, wall_ms=? WHERE id = ?",
                 (status, verdict or None, confidence, summary, _dump(result) if result else None,
                  error, now(), wall, run_id))
        self.s.event(f"review.{status}", run_id, verdict or error[:200])

    def set_transition(self, run_id: str, state: str, target: str = "", note: str = "",
                       by: str = "") -> None:
        self.s.x("UPDATE review_runs SET transition_state=?, transition_target=COALESCE(NULLIF(?, ''), "
                 "transition_target), transition_note=?, transition_at=?, transition_by=? WHERE id=?",
                 (state, target, note[:500], now(), by, run_id))

    def set_comment_state(self, run_id: str, state: str) -> None:
        self.s.x("UPDATE review_runs SET comment_state = ? WHERE id = ?", (state, run_id))

    def request_cancel(self, run_id: str) -> str:
        row = self.s.q1("SELECT status FROM review_runs WHERE id = ?", (run_id,))
        if not row:
            raise cat.ValidationError("прогон не найден")
        if row["status"] == "queued":
            self.s.x("UPDATE review_runs SET status='cancelled', finished_at=? WHERE id=?", (now(), run_id))
            self.s.event("review.cancelled", run_id, "")
            return "cancelled"
        if row["status"] == "running":
            self.s.x("UPDATE review_runs SET cancel_requested = 1 WHERE id = ?", (run_id,))
            return "cancel_requested"
        return row["status"]

    def run(self, run_id: str) -> dict | None:
        row = self.s.q1("SELECT * FROM review_runs WHERE id = ?", (run_id,))
        if not row:
            return None
        for key in ("request", "snapshot", "result"):
            row[key] = _j(row[key], {})
        return row

    def runs(self, card_id: str = "", status: str = "", limit: int = 50) -> list[dict]:
        sql, params = ("SELECT id, card_id, board, card_title, status, verdict, confidence, summary, "
                       "profile_name, method, requested_by, transition_state, transition_target, "
                       "comment_state, created_at, started_at, finished_at, wall_ms, error "
                       "FROM review_runs WHERE 1=1"), []
        if card_id:
            sql, params = sql + " AND card_id = ?", params + [card_id]
        if status:
            sql, params = sql + " AND status = ?", params + [status]
        return self.s.q(sql + " ORDER BY created_at DESC LIMIT ?", tuple(params) + (min(limit, 200),))

    def counts(self) -> dict:
        return {r["status"]: r["n"] for r in
                self.s.q("SELECT status, COUNT(*) n FROM review_runs GROUP BY status")}

    # ── транскрипт и аудит ───────────────────────────────────────────────────
    def log_step(self, run_id: str, stage_no: int, stage_type: str, agent_key: str, model: str,
                 params: dict, prompt: str, response: str, data: dict | None, ok: bool,
                 error: str, ms: int, tokens_in: int, tokens_out: int) -> None:
        self.s.x("INSERT INTO review_steps (run_id, stage_no, stage_type, agent_key, model, params, "
                 "prompt, response, data, ok, error, ms, tokens_in, tokens_out, created_at) "
                 "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                 (run_id, stage_no, stage_type, agent_key, model, _dump(params), prompt, response,
                  _dump(data) if data is not None else None, 1 if ok else 0, error[:500], ms,
                  tokens_in, tokens_out, now()))

    def steps(self, run_id: str, with_text: bool = False) -> list[dict]:
        cols = "*" if with_text else ("id, stage_no, stage_type, agent_key, model, params, data, ok, "
                                      "error, ms, tokens_in, tokens_out, created_at")
        rows = self.s.q(f"SELECT {cols} FROM review_steps WHERE run_id = ? ORDER BY id", (run_id,))
        for r in rows:
            r["params"] = _j(r.get("params"), {})
            r["data"] = _j(r.get("data"), None)
        return rows

    def step(self, step_id: int) -> dict | None:
        row = self.s.q1("SELECT * FROM review_steps WHERE id = ?", (step_id,))
        if row:
            row["params"] = _j(row["params"], {})
            row["data"] = _j(row["data"], None)
        return row

    def audit(self, run_id: str, card_id: str, action: str, actor: str, from_status: str = "",
              to_status: str = "", detail: str = "") -> None:
        self.s.x("INSERT INTO review_audit (run_id, card_id, action, actor, from_status, to_status, "
                 "detail, at) VALUES (?,?,?,?,?,?,?,?)",
                 (run_id, card_id, action, actor, from_status, to_status, detail[:1000], now()))
        self.s.event(f"review.{action}", run_id, f"{from_status} → {to_status}".strip(" →"))

    def audit_log(self, run_id: str = "", limit: int = 100) -> list[dict]:
        if run_id:
            return self.s.q("SELECT * FROM review_audit WHERE run_id = ? ORDER BY id", (run_id,))
        return self.s.q("SELECT * FROM review_audit ORDER BY id DESC LIMIT ?", (min(limit, 500),))
