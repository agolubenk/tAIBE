#!/usr/bin/env python3
"""AI Council — карточки t-boards по запросу, только чтение (OPS-26). Канон: docs/specs/ai-council.md §10.

    pbpaste | TAIBE_HOST_ROOT="$PWD" python3 <tAIBE>/infra/ai-council/tboards.py set-key   # из корня продукта →
                                                               # <хост>/.claude/council/tboards.json
    python3 infra/ai-council/tboards.py status [--check]       # продукт, адрес, файл; --check — один GET
    python3 infra/ai-council/tboards.py card OPS-26            # карточка из t-boards → база консилиума
    python3 infra/ai-council/tboards.py cards [--q текст] [--db bugs|tasks] [--limit 20]

Фона нет (решение d-ops23-forks-0511, Р0 б): карточка читается в момент вызова. Ключ свой на продукт
(d-tb-product-key-0411). Файл хоста привязывает ключ к адресу доски и к воркспейсу: ключ на несколько продуктов,
на другой продукт или на чужой адрес не уходит. Клиент умеет только GET по закрытому списку путей. Тексты ошибок
не содержат ни ключа, ни заголовков, ни текста исключения запроса: их читают агент, лог и MCP.
"""
from __future__ import annotations

import argparse
import gzip
import http.client
import io
import json
import math
import os
import re
import ssl
import stat
import sys
import time
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as config_mod  # noqa: E402  — кладёт .claude/scripts слоя в sys.path
import product  # noqa: E402  — словарь модулей продукта (Ф2 OPS-23)
import pipeline_settings  # noqa: E402  — доверенные хосты и CA системы: одно место на слой

KEY_FILE_REL = ".claude/council/tboards.json"
PIN_KEY = "tboards:workspace"
KEY_RE = re.compile(r"[A-Za-z0-9_-]{16,256}")
ID_RE = re.compile(r"[a-z0-9]{20,32}")
TICKET_RE = re.compile(r"[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9]{0,15}-\d{1,7}")
UUID_RE = re.compile(r"[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}")
MAX_BYTES = 8 * 1024 * 1024
DEFAULT_BUDGET = 40          # лимит ключа — 100 запросов, сброс после 60 с тишины (better-auth)
RETRY_AFTER_MAX = 5
TIMEOUT = 15
LOCAL_HOSTS = ("localhost", "127.0.0.1")
PRIORITY = {"urgent": "P0", "high": "P1", "medium": "P2", "low": "P3"}
FINAL_SLUGS = ("done", "closed", "выполненные", "завершённые", "закрыто")
REVIEW_SLUGS = ("in-review", "на-ревью")


class TBoardsError(Exception):
    """Текст безопасен для агента и лога. `code` — для кода и тестов."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ── адрес и ключ ─────────────────────────────────────────────────────────────
def trusted_url(raw: str) -> str:
    """Схема и хост доски, собранные заново. Ключ уходит только на хост из `KNOWN_HOSTS` слоя по https или на
    локальный хост по http; путь, логин, параметры и обратный слэш — отказ (urllib и urlsplit читают их по-разному)."""
    raw = (raw or "").strip()
    parts = urllib.parse.urlsplit(raw)
    host = (parts.hostname or "").lower()
    try:
        port = parts.port
    except ValueError:
        raise TBoardsError("bad_url", "адрес доски: неверный порт") from None
    if (not host or "\\" in raw or parts.username or parts.password or parts.query or parts.fragment
            or parts.path not in ("", "/")):
        raise TBoardsError("bad_url", "адрес доски: только схема и хост, без пути, логина и параметров")
    if not ((parts.scheme == "https" and host in pipeline_settings.KNOWN_HOSTS)
            or (parts.scheme == "http" and host in LOCAL_HOSTS)):
        raise TBoardsError("untrusted_url", f"хост {host!r} не в списке доверенных (KNOWN_HOSTS слоя) — "
                                            "ключ туда не уходит")
    return f"{parts.scheme}://{host}" + (f":{port}" if port else "")


def key_path(root: Path | None = None) -> Path:
    return Path(root or config_mod.REPO_ROOT) / KEY_FILE_REL


def _set_key_hint() -> str:
    # Хост задаёт TAIBE_HOST_ROOT: без него хост — сама папка tAIBE, и ключ лёг бы не к тому продукту.
    return (f"выпустите в t-boards ключ, ограниченный продуктом (Настройки → API-ключи), и из корня продукта: "
            f"`pbpaste | TAIBE_HOST_ROOT=\"$PWD\" python3 {HERE / 'tboards.py'} set-key`")


def load_key(root: Path | None = None) -> dict:
    """{url, key, workspace, slug, name} из файла хоста. Симлинк, чужой владелец, права группы или мира, файл вне
    `<хост>/.claude/council/` — отказ: путь к хосту задаёт env `TAIBE_HOST_ROOT`, а его меняет коммит."""
    root = Path(root or config_mod.REPO_ROOT)
    path = key_path(root)
    expected_dir = os.path.join(os.path.realpath(root), ".claude", "council")
    if os.path.realpath(path.parent) != expected_dir:
        raise TBoardsError("bad_key_file", f"{path.parent}: папка ключа — не `.claude/council` хоста")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        raise TBoardsError("no_key", f"нет ключа t-boards у этого продукта ({path}) — {_set_key_hint()}") from None
    except OSError as exc:
        raise TBoardsError("bad_key_file", f"{path}: не открыт ({type(exc).__name__}; симлинк не принимается)") \
            from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise TBoardsError("bad_key_file", f"{path}: не обычный файл")
        if st.st_uid != os.getuid():
            raise TBoardsError("bad_key_file", f"{path}: владелец — другой пользователь")
        if st.st_mode & 0o077:
            raise TBoardsError("bad_key_file", f"{path}: права {oct(st.st_mode & 0o777)} — нужно `chmod 600 {path}`")
        raw = os.read(fd, 4097)
    finally:
        os.close(fd)
    try:
        data = json.loads(raw.decode("utf-8")) if len(raw) <= 4096 else None
    except (ValueError, UnicodeDecodeError):
        data = None
    if not isinstance(data, dict) or not KEY_RE.fullmatch(str(data.get("key") or "")) \
            or not ID_RE.fullmatch(str(data.get("workspace") or "")):
        raise TBoardsError("bad_key_file", f"{path}: файл повреждён — {_set_key_hint()}")
    return {"url": trusted_url(str(data.get("url") or "")), "key": data["key"], "workspace": data["workspace"],
            "slug": str(data.get("slug") or ""), "name": str(data.get("name") or "")}


def _retry_after(headers: dict) -> float | None:
    for name in ("retry-after", "x-retry-after"):
        try:
            value = float(headers.get(name, ""))
        except ValueError:
            continue
        return max(0.0, value) if math.isfinite(value) else None
    return None


STATUS_TEXT = {
    401: "ключ не принят (401) — ключ отозван или неверен; заново: " + "set-key",
    403: "нет доступа (403) — у ключа нет прав на этот ресурс продукта",
    404: "не найдено (404) — карточки нет или она в другом продукте",
    409: "неоднозначный ключ карточки (409) — укажите id t-boards",
}


# ── клиент ───────────────────────────────────────────────────────────────────
class Client:
    """Одно соединение на вызов инструмента (keep-alive, gzip, без прокси и редиректов) и бюджет запросов."""

    def __init__(self, url: str, key: str, workspace: str = "", slug: str = "", name: str = "",
                 budget: int = DEFAULT_BUDGET, timeout: float = TIMEOUT, sleep=time.sleep):
        if not KEY_RE.fullmatch(key or ""):
            raise TBoardsError("bad_key", "ключ не похож на ключ t-boards — " + _set_key_hint())
        self.base = urllib.parse.urlsplit(trusted_url(url))
        self.url = trusted_url(url)
        self.key, self.workspace, self.slug, self.name = key, workspace, slug, name
        self.budget, self.calls, self.timeout, self._sleep = budget, 0, timeout, sleep
        self._conn: http.client.HTTPConnection | None = None
        self._projects: dict | None = None

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _connect(self) -> http.client.HTTPConnection:
        host, port = self.base.hostname, self.base.port
        if self.base.scheme == "https":
            ctx = pipeline_settings._tls_context() or ssl.create_default_context()
            return http.client.HTTPSConnection(host, port, timeout=self.timeout, context=ctx)
        return http.client.HTTPConnection(host, port, timeout=self.timeout)

    def _request(self, path: str) -> tuple[int, dict, bytes]:
        headers = {"x-api-key": self.key, "accept": "application/json", "accept-encoding": "gzip",
                   "user-agent": "ai-council-tboards/1"}
        for fresh in (False, True):
            if self._conn is None or fresh:
                self.close()
                self._conn = self._connect()
            try:
                self._conn.request("GET", path, headers=headers)
                resp = self._conn.getresponse()
                body = resp.read(MAX_BYTES + 1)
                hdrs = {k.lower(): v for k, v in resp.getheaders()}
                if len(body) > MAX_BYTES or hdrs.get("connection", "").lower() == "close":
                    self.close()
                if len(body) > MAX_BYTES:
                    raise TBoardsError("too_large", "t-boards: ответ больше 8 МиБ — сузьте запрос")
                return resp.status, hdrs, body
            except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError):
                self.close()
                if fresh:
                    raise TBoardsError("network", "t-boards: соединение оборвано") from None
            except ValueError:
                self.close()
                raise TBoardsError("bad_key", "ключ или путь с недопустимыми символами") from None
            except (OSError, http.client.HTTPException) as exc:
                self.close()
                raise TBoardsError("network", f"t-boards недоступен ({type(exc).__name__})") from None
        raise TBoardsError("network", "t-boards: соединение оборвано")

    def get(self, template: str, *segments: str, query: dict | None = None):
        """GET по шаблону пути. Сегменты — id, ключ карточки или воркспейс, каждый проверен и закодирован."""
        for seg in segments:
            if not (ID_RE.fullmatch(seg) or TICKET_RE.fullmatch(seg)):
                raise TBoardsError("bad_ref", "ключ карточки вида OPS-26 или id t-boards")
        path = template.format(*(urllib.parse.quote(s, safe="") for s in segments))
        if query:
            path += "?" + urllib.parse.urlencode(query)
        for attempt in range(2):
            if self.calls >= self.budget:
                raise TBoardsError("budget", f"бюджет запросов на вызов исчерпан ({self.budget}) — сузьте запрос")
            self.calls += 1
            status, headers, body = self._request(path)
            if status == 200:
                return self._decode(headers, body)
            if attempt == 0 and status == 429:
                wait = _retry_after(headers)
                if wait is not None and wait <= RETRY_AFTER_MAX:
                    self._sleep(wait)
                    continue
                raise TBoardsError("rate_limited", "t-boards: лимит ключа (429)"
                                   + (f", повтор через {int(wait)} с" if wait is not None else "") + " — позже")
            if attempt == 0 and status == 503:
                self._sleep(1)
                continue
            if 300 <= status < 400:
                raise TBoardsError("redirect", f"t-boards ответил переадресацией ({status}) — ключ за ней не уходит")
            raise TBoardsError(f"http_{status}", "t-boards: " + STATUS_TEXT.get(status, f"ошибка {status}"))
        raise TBoardsError("unavailable", "t-boards: сервис занят (503) — позже")

    @staticmethod
    def _decode(headers: dict, body: bytes):
        try:
            if headers.get("content-encoding") == "gzip":
                body = gzip.GzipFile(fileobj=io.BytesIO(body)).read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES:
                    raise TBoardsError("too_large", "t-boards: ответ больше 8 МиБ — сузьте запрос")
            return json.loads(body.decode("utf-8"))
        except (OSError, EOFError, ValueError, UnicodeDecodeError):
            raise TBoardsError("bad_answer", "t-boards: ответ не JSON") from None

    # ── маршруты (весь список; других у консилиума нет) ─────────────────────
    def workspaces(self) -> list:
        rows = self.get("/api/workspace")
        return [w for w in rows if isinstance(w, dict) and w.get("id")] if isinstance(rows, list) else []

    def projects(self) -> dict:
        if self._projects is None:
            rows = self.get("/api/project", query={"workspaceId": self.workspace})
            self._projects = {p["id"]: p for p in rows or [] if isinstance(p, dict) and p.get("id")}
        return self._projects

    def task(self, ref: str) -> dict:
        ref = (ref or "").strip()
        if TICKET_RE.fullmatch(ref):
            task = self.get("/api/task/by-ticket-id/{}", ref.upper(), query={"workspaceId": self.workspace})
        elif ID_RE.fullmatch(ref):
            task = self.get("/api/task/{}", ref)
        else:
            raise TBoardsError("bad_ref", "ключ карточки вида OPS-26 или id t-boards")
        if not isinstance(task, dict) or not task.get("id"):
            raise TBoardsError("bad_answer", "t-boards: карточка без id")
        if task.get("workspaceId") != self.workspace:
            raise TBoardsError("wrong_product", "карточка из другого продукта — у этого хоста свой воркспейс")
        return task

    def meta(self, task_id: str) -> dict:
        data = self.get("/api/forest/{}/cards/{}/meta", self.workspace, task_id)
        return data if isinstance(data, dict) else {}

    def labels(self, task_id: str) -> list:
        data = self.get("/api/label/task/{}", task_id)
        return data if isinstance(data, list) else []

    def comments(self, task_id: str) -> list:
        data = self.get("/api/comment/{}", task_id)
        return data if isinstance(data, list) else []

    def board(self, project_id: str, status: str) -> tuple[list, list]:
        """(задачи колонки `status`, все колонки доски) — список проекта с фильтром статуса, все страницы по 100
        (`pagination.totalPages`): иначе карточки после сотой выпали бы из очереди ревью."""
        tasks: list = []
        columns: list = []
        page, pages = 1, 1
        while page <= pages:
            data = self.get("/api/task/tasks/{}", project_id, query={"status": status, "limit": 100, "page": page})
            data = data if isinstance(data, dict) else {}
            board = data.get("data") or {}
            columns = [c for c in board.get("columns") or [] if isinstance(c, dict)] or columns
            tasks += [t for c in board.get("columns") or [] if isinstance(c, dict)
                      for t in c.get("tasks") or [] if isinstance(t, dict) and t.get("status") == status]
            try:
                pages = max(1, min(int((data.get("pagination") or {}).get("totalPages") or 1), 50))
            except (TypeError, ValueError):
                pages = 1
            page += 1
        return tasks, columns

    def search(self, q: str, limit: int) -> list:
        data = self.get("/api/search", query={"q": q[:200], "type": "tasks", "workspaceId": self.workspace,
                                              "limit": max(1, min(int(limit), 50))})
        rows = (data or {}).get("results") if isinstance(data, dict) else None
        return [r for r in rows or [] if isinstance(r, dict) and r.get("type", "task") == "task"]


def build(cfg=None, root: Path | None = None, budget: int | None = None) -> Client:
    key = load_key(root)
    cap = budget or int((cfg.get("sources.tboards.call_budget", DEFAULT_BUDGET) if cfg else DEFAULT_BUDGET) or 0)
    return Client(key["url"], key["key"], key["workspace"], key["slug"], key["name"], budget=max(1, min(cap, 95)))


# ── карточка → строка cards ──────────────────────────────────────────────────
def _uuid(value) -> str:
    raw = str(value or "").strip().lower()
    if not UUID_RE.fullmatch(raw):
        return ""
    h = raw.replace("-", "")
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def ticket_of(task: dict, project: dict) -> str:
    slug, number = str(project.get("slug") or "").upper(), task.get("number")
    return f"{slug}-{number}" if slug and number is not None else ""


def task_to_card(task: dict, meta: dict, labels: list, comments: list, project: dict, client: Client,
                 final_slugs=FINAL_SLUGS) -> dict:
    """Строка `cards`. card_id перенесённой карточки — её Notion-id (`meta.notionPageId`): прогоны, заметки и ревью
    остаются при ней. Тело, комментарии и отчёт — через scrub (секреты и ПДн до базы, промптов и облака); автор
    комментария не хранится."""
    from knowledge_external import scrub
    from store import sha16

    ticket = ticket_of(task, project)
    status = str(task.get("status") or "")
    body = scrub(str(task.get("description") or ""))
    report = scrub(str(meta.get("report") or "")) or None
    notes = [{"id": str(c.get("id") or ""), "text": scrub(str(c.get("content") or "")),
              "at": str(c.get("createdAt") or "")} for c in comments if isinstance(c, dict)]
    names = {str(lb.get("name") or "").strip().lower() for lb in labels if isinstance(lb, dict)}
    modules = sorted(names & set(product.current().modules))  # словарь продукта (Ф2 OPS-23)
    priority = PRIORITY.get(str(task.get("priority") or ""))
    severity = str(meta.get("severity") or "") or None
    half_baked = 1 if meta.get("halfBaked") else 0
    significant = "|".join([str(task.get("title") or ""), status, priority or "", severity or "", ",".join(modules),
                            report or "", str(half_baked), body, "|".join(n["text"] for n in notes)])
    return {
        "card_id": _uuid(meta.get("notionPageId")) or task["id"],
        "db": "bugs" if meta.get("kind") == "bug" else "tasks",
        "title": str(task.get("title") or ""),
        "url": f"{client.url}/{client.slug}/task/{ticket}" if ticket and client.slug else client.url,
        "status": status, "priority": priority, "severity": severity, "task_type": None, "source": None,
        "backlog_id": str(meta.get("backlogId") or "") or ticket or None,
        "modules": json.dumps(modules, ensure_ascii=False), "tags": "[]", "half_baked": half_baked,
        "parent_card_id": None, "subtask_ids": "[]", "report": report, "body": body,
        "comments": json.dumps(notes, ensure_ascii=False), "content_hash": sha16(significant),
        "notion_edited_at": None, "fetched_at": int(time.time()),
        "origin": "tboards", "ticket": ticket or None, "board_task_id": task["id"],
        "is_final": 1 if task.get("completedAt") or status in final_slugs else 0,
    }


def check_pin(store, workspace: str) -> None:
    """База хоста закреплена за продуктом первого ключа: подменённый файл ключа другого продукта не нальёт в неё
    чужие карточки."""
    store.x("INSERT OR IGNORE INTO council_state (key, value, updated_at) VALUES (?, ?, ?)",
            (PIN_KEY, workspace, int(time.time())))
    row = store.q1("SELECT value FROM council_state WHERE key = ?", (PIN_KEY,))
    if row and row["value"] and row["value"] != workspace:
        raise TBoardsError("wrong_product", "база консилиума этого хоста закреплена за другим продуктом — "
                                            "ключ не того продукта? Проверьте файл ключа: `tboards.py status`")


def fetch_card(cfg, ref: str, client: Client) -> dict:
    """Карточка по ключу или id: деталь, мета, метки, комментарии (+ проекты один раз) — 4–5 запросов."""
    task = client.task(ref)
    meta, labels, comments = client.meta(task["id"]), client.labels(task["id"]), client.comments(task["id"])
    project = client.projects().get(task.get("projectId")) or {}
    finals = tuple(cfg.get("sources.tboards.final_slugs", FINAL_SLUGS) if cfg else FINAL_SLUGS)
    return task_to_card(task, meta, labels, comments, project, client, finals)


def fetch_into_store(cfg, store, ref: str, client: Client | None = None) -> dict:
    own = client is None
    client = client or build(cfg)
    try:
        card = fetch_card(cfg, ref, client)
    finally:
        if own:
            client.close()
    check_pin(store, client.workspace)
    store.upsert_card(card)
    return store.get_card(card["card_id"]) or card


def card_line(card: dict) -> str:
    kind = f"bug:{card.get('severity') or '?'}" if card.get("db") == "bugs" else "task"
    key = card.get("ticket") or str(card.get("card_id") or "")[:12]
    flag = "[half-baked] " if card.get("half_baked") else ""
    return f"{key:<10} {str(card.get('status') or ''):<16} {card.get('priority') or '—':<3} {kind:<12} " \
           f"{flag}{str(card.get('title') or '')[:80]}"


# ── CLI ──────────────────────────────────────────────────────────────────────
def _out(lines: list[str], cap: int = 6000) -> None:
    text = "\n".join(lines)
    if len(text) > cap:
        text = text[:cap].rsplit("\n", 1)[0] + "\n… ответ обрезан до 6 КБ — сузьте запрос (--q, --limit)"
    print(text)


def cmd_cards(cfg, args) -> int:
    from store import Store
    limit = max(1, min(int(args.limit or 20), 50))
    q = (args.q or "").strip()
    with Store() as store:
        if q and (TICKET_RE.fullmatch(q) or ID_RE.fullmatch(q)):
            try:
                with build(cfg) as client:
                    card = fetch_into_store(cfg, store, q, client)
                _out([f"t-boards · {client.name or client.slug}: карточка (данные на сейчас)", card_line(card),
                      f"  {card.get('url')}", "", (card.get("body") or "")[:3000]])
                return 0
            except TBoardsError as exc:
                if TICKET_RE.fullmatch(q) or exc.code != "http_404":
                    raise                               # похожее на id слово без карточки — дальше поиском
        if q:
            with build(cfg) as client:
                rows, projects = client.search(q, limit), client.projects()
            lines = [f"t-boards · {client.name or client.slug}: поиск «{q[:60]}», {len(rows)} (вид карточки — по ключу)"]
            for r in rows[:limit]:
                ticket = f"{r.get('projectSlug') or (projects.get(r.get('projectId')) or {}).get('slug', '')}-" \
                         f"{r.get('taskNumber')}" if r.get("taskNumber") is not None else str(r.get("id"))[:12]
                lines.append(f"{ticket:<10} {str(r.get('status') or ''):<16} {str(r.get('title') or '')[:90]}")
            _out(lines)
            return 0
        sql = "SELECT * FROM cards WHERE origin = 'tboards' AND COALESCE(is_final, 0) = 0"
        params: list = []
        if args.db:
            sql, params = sql + " AND db = ?", [args.db]
        rows = store.q(sql + " ORDER BY fetched_at DESC LIMIT ?", tuple(params + [limit]))
    lines = [f"карточки t-boards, уже прочитанные консилиумом: {len(rows)} (без сети; свежие — по ключу или --q)"]
    _out(lines + [card_line(r) for r in rows])
    return 0


def cmd_card(cfg, args) -> int:
    from store import Store
    with Store() as store:
        card = fetch_into_store(cfg, store, args.ref)
    _out([card_line(card), f"  {card.get('url')}"])
    return 0


def cmd_status(cfg, args) -> int:
    from store import Store
    path = key_path()
    try:
        key = load_key()
    except TBoardsError as exc:
        print(f"ключ t-boards: ✗ {exc}")
        return 1
    with Store() as store:
        pin = store.q1("SELECT value FROM council_state WHERE key = ?", (PIN_KEY,))
    pinned = (pin or {}).get("value") or ""
    print(f"ключ t-boards: ✓ {path} (0600) · продукт «{key['name']}» ({key['slug']}) · {key['url']}")
    print(f"база хоста закреплена за: {pinned or '— ещё нет (первая карточка закрепит)'}"
          + (" ✗ ДРУГОЙ ПРОДУКТ" if pinned and pinned != key["workspace"] else ""))
    if args.check:
        with build(cfg, budget=2) as client:
            rows = client.workspaces()
        ok = len(rows) == 1 and rows[0]["id"] == key["workspace"]
        print(f"проверка ключа: {'✓' if ok else '✗'} видит {len(rows)} воркспейс(ов)")
        return 0 if ok else 1
    return 1 if pinned and pinned != key["workspace"] else 0


def cmd_set_key(cfg, args) -> int:
    from store import Store
    raw = sys.stdin.read().strip()
    if not KEY_RE.fullmatch(raw):
        print("ключ не похож на ключ t-boards (одна строка [A-Za-z0-9_-], 16–256 символов)", file=sys.stderr)
        return 1
    layer_url = str(pipeline_settings._instance(str(config_mod.LAYER_ROOT)).get("url") or "")
    with Client(args.url or layer_url, raw, budget=2) as client:
        rows = client.workspaces()
    if len(rows) != 1:
        names = ", ".join(sorted(str(w.get("name") or "?") for w in rows)) or "ни одного"
        print(f"ключ видит не один продукт ({names}) — нужен ключ, ограниченный одним продуктом", file=sys.stderr)
        return 1
    ws = rows[0]
    if not ID_RE.fullmatch(str(ws.get("id") or "")):
        print("t-boards вернул воркспейс без id", file=sys.stderr)
        return 1
    with Store() as store:
        check_pin(store, ws["id"])
    path = key_path()
    tmp = path.with_name(path.name + ".tmp")
    if tmp.exists() or tmp.is_symlink():
        tmp.unlink()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"url": client.url, "key": raw, "workspace": ws["id"], "slug": str(ws.get("slug") or ""),
                   "name": str(ws.get("name") or ""), "set_at": int(time.time())}, fh, ensure_ascii=False)
    os.replace(tmp, path)
    print(f"✓ ключ продукта «{ws.get('name')}» ({ws.get('slug')}) сохранён: {path} (0600), адрес {client.url}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="AI Council — карточки t-boards по запросу (только чтение)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("cards", help="карточки: --q ключ|id|текст; без --q — уже прочитанные, без сети")
    p.add_argument("--q", default="")
    p.add_argument("--db", choices=["bugs", "tasks"], default="")
    p.add_argument("--limit", type=int, default=20)
    p = sub.add_parser("card", help="одна карточка из t-boards в базу консилиума")
    p.add_argument("ref")
    p = sub.add_parser("status", help="ключ и продукт; --check — один GET")
    p.add_argument("--check", action="store_true")
    p = sub.add_parser("set-key", help="ключ продукта из stdin → файл хоста (0600)")
    p.add_argument("--url", default="", help="адрес доски; по умолчанию boards.url слоя")
    args = parser.parse_args(argv)
    cfg = config_mod.load(strict=False)
    handler = {"cards": cmd_cards, "card": cmd_card, "status": cmd_status, "set-key": cmd_set_key}[args.cmd]
    try:
        return handler(cfg, args)
    except TBoardsError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
