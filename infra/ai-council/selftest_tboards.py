#!/usr/bin/env python3
"""AI Council — самопроверка источника t-boards (tboards.py, OPS-26). Только stdlib, без моделей и без сети наружу.

Вызывается из selftest.py. Фейковый t-boards на 127.0.0.1: файл ключа (права, симлинк, порча), доверенный адрес,
ключ не попадает в тексты ошибок, только GET, gzip, 429 и 503, бюджет запросов, отказ на переадресацию, карточка
чужого продукта; строка cards (card_id перенесённой карточки = Notion-id, scrub ПДн, без автора комментария), база
закреплена за продуктом, снимок Notion не идёт в работу, однократный сброс очереди ревью, очередь ревью по колонкам,
`run --card next` — отказ, MCP-чтение без шлюза (`gateway.py --get`).
"""
from __future__ import annotations

import contextlib
import gzip
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

WS = "lth89qy6f8j1greiy4c5cn23"
OTHER_WS = "jbza3jvj5qtkquur7mpaxzet"
PROJECT = "mjwiozcdb50f7imppo1n2emv"
TASK = "v70213t2q39ae45ii9mmy2pp"
BUG = "ps1t9p2v86g75ukkbgv3d83m"
FOREIGN = "zzzzzzzzzzzzzzzzzzzzzzzz"
NOTION_ID = "3b9dd207a82581dfb95adf2a95472dbf"
KEY = "k" * 40


class FakeBoard:
    seen: list = []
    mode: dict = {}

    @staticmethod
    def task(task_id: str, **extra) -> dict:
        base = {"id": task_id, "projectId": PROJECT, "workspaceId": WS, "number": 26, "title": "Консилиум без Notion",
                "description": "Пишите на ivan.petrov@example.com или +7 916 123-45-67", "status": "in-review",
                "priority": "high", "completedAt": None}
        return {**base, **extra}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        return

    def _reply(self, code: int, payload=None, headers: dict | None = None, gz: bool = False) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else b""
        if gz:
            body = gzip.compress(body)
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        FakeBoard.seen.append(("POST", self.path))
        self._reply(405, {"error": "no"})

    def do_GET(self):  # noqa: N802
        FakeBoard.seen.append(("GET", self.path, self.headers.get("x-api-key"), self.headers.get("accept-encoding")))
        path, _, query = self.path.partition("?")
        mode = FakeBoard.mode
        if mode.get("429") and mode["429"] > 0:
            mode["429"] -= 1
            return self._reply(429, {"error": "slow"}, {"Retry-After": str(mode.get("retry_after", 1))})
        if mode.get("503") and mode["503"] > 0:
            mode["503"] -= 1
            return self._reply(503, {"error": "busy"})
        if mode.get("redirect"):
            return self._reply(302, None, {"Location": "http://127.0.0.1:9/steal"})
        gz = "gzip" in (self.headers.get("accept-encoding") or "")
        if path == "/api/workspace":
            rows = [{"id": WS, "name": "aiBoards&eval", "slug": "aiboards-eval"}]
            if mode.get("two_ws"):
                rows.append({"id": OTHER_WS, "name": "Lavaeon (HR Helper)", "slug": "hr-helper-lavaeon"})
            return self._reply(200, rows, gz=gz)
        if path == "/api/project":
            return self._reply(200, [{"id": PROJECT, "workspaceId": WS, "slug": "OPS", "name": "Инфраструктура"}], gz=gz)
        if path == "/api/task/by-ticket-id/OPS-26":
            return self._reply(200, FakeBoard.task(TASK), gz=gz)
        if path == f"/api/task/{TASK}":
            return self._reply(200, FakeBoard.task(TASK), gz=gz)
        if path == f"/api/task/{FOREIGN}":
            return self._reply(200, FakeBoard.task(FOREIGN, workspaceId=OTHER_WS), gz=gz)
        if path == f"/api/forest/{WS}/cards/{TASK}/meta":
            return self._reply(200, {"kind": "bug", "severity": "high", "backlogId": None, "halfBaked": False,
                                     "report": "отчёт: token=sk-abcdefghijklmnopqrstuvwx", "notionPageId": NOTION_ID},
                               gz=gz)
        if path == f"/api/forest/{WS}/cards/{BUG}/meta":
            return self._reply(200, {"kind": "task", "halfBaked": True}, gz=gz)
        if path.startswith("/api/label/task/"):
            return self._reply(200, [{"id": "l1", "name": "Backend"}, {"id": "l2", "name": "срочно"}], gz=gz)
        if path.startswith("/api/comment/"):
            return self._reply(200, [{"id": "c1", "content": "звоните +7 916 123-45-67", "createdAt": "2026-11-07",
                                      "userId": "u1", "user": {"name": "Иван Петров"}}], gz=gz)
        if path == f"/api/task/tasks/{PROJECT}":
            status = dict(p.split("=", 1) for p in query.split("&") if "=" in p).get("status")
            tasks = [FakeBoard.task(TASK), FakeBoard.task(BUG, number=27, title="вторая")] if status == "in-review" \
                else []
            columns = [{"slug": "in-review", "isFinal": False, "tasks": tasks}, {"slug": "done", "isFinal": True,
                                                                               "tasks": []}]
            return self._reply(200, {"data": {"columns": columns}, "pagination": {"total": len(tasks)}}, gz=gz)
        if path == "/api/search":
            return self._reply(200, {"results": [{"id": TASK, "type": "task", "title": "Консилиум без Notion",
                                                  "projectSlug": "OPS", "taskNumber": 26, "status": "in-review"}],
                                     "totalCount": 1}, gz=gz)
        return self._reply(404, {"error": "nope"})


@contextlib.contextmanager
def fake_board():
    FakeBoard.seen, FakeBoard.mode = [], {}
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def _host(tmp: Path, name: str, url: str, mode: int = 0o600, key: str = KEY) -> Path:
    root = tmp / name
    (root / ".claude" / "council").mkdir(parents=True, exist_ok=True)
    path = root / ".claude" / "council" / "tboards.json"
    if path.exists() or path.is_symlink():
        path.unlink()
    path.write_text(json.dumps({"url": url, "key": key, "workspace": WS, "slug": "aiboards-eval",
                                "name": "aiBoards&eval"}), encoding="utf-8")
    os.chmod(path, mode)
    return root


def _raises(fn, code: str):
    import tboards
    try:
        fn()
    except tboards.TBoardsError as exc:
        return exc.code == code, str(exc)
    return False, "без исключения"


def _key_and_url(check, tb, tmp: Path, url: str) -> None:
    root = _host(tmp, "h-mode", url, 0o644)
    ok, why = _raises(lambda: tb.load_key(root), "bad_key_file")
    check("t-boards: файл ключа с правами 0644 — отказ с командой chmod 600", ok and "chmod 600" in why, why)
    root = _host(tmp, "h-link", url)
    real = root / ".claude" / "council" / "real.json"
    (root / ".claude" / "council" / "tboards.json").rename(real)
    (root / ".claude" / "council" / "tboards.json").symlink_to(real)
    ok, why = _raises(lambda: tb.load_key(root), "bad_key_file")
    check("t-boards: симлинк вместо файла ключа — отказ", ok and "симлинк" in why, why)
    root = _host(tmp, "h-nl", url, key="abc\nX-Leak: 1" + "q" * 20)
    ok, why = _raises(lambda: tb.load_key(root), "bad_key_file")
    check("t-boards: ключ с переводом строки — отказ, ключа в тексте нет", ok and "X-Leak" not in why, why)
    (tmp / "h-none" / ".claude" / "council").mkdir(parents=True, exist_ok=True)
    ok, why = _raises(lambda: tb.load_key(tmp / "h-none"), "no_key")
    check("t-boards: нет ключа — отказ с командой set-key", ok and "set-key" in why, why)
    good = tb.load_key(_host(tmp, "h-good", url))
    check("t-boards: годный файл ключа — адрес, ключ, воркспейс", good["workspace"] == WS and good["url"] == url)
    for bad, code in (("https://evil.example.org", "untrusted_url"), ("http://d4dev.admin.hrhelper.space", "untrusted_url"),
                      ("https://evil.com\\@d4dev.admin.hrhelper.space", "bad_url"),
                      ("https://user@d4dev.admin.hrhelper.space", "bad_url"),
                      ("https://d4dev.admin.hrhelper.space/x?y=1", "bad_url")):
        ok, why = _raises(lambda b=bad: tb.trusted_url(b), code)
        check(f"t-boards: адрес {bad[:42]} — отказ ({code})", ok, why)
    check("t-boards: доверенный хост по https собирается заново",
          tb.trusted_url("https://D4DEV.admin.hrhelper.space/") == "https://d4dev.admin.hrhelper.space")
    ok, why = _raises(lambda: tb.Client(url, "ab\ncd" + "e" * 20, WS), "bad_key")
    check("t-boards: клиент с битым ключом не создаётся, ключа в тексте нет", ok and "ab\ncd" not in why, why)


def _client(check, tb, url: str) -> None:
    sleeps: list = []
    with tb.Client(url, KEY, WS, "aiboards-eval", "aiBoards&eval", sleep=sleeps.append) as client:
        task = client.task("ops-26")
        check("t-boards: карточка по ключу (регистр не важен), gzip расшифрован",
              task["id"] == TASK and all(s[3] == "gzip" for s in FakeBoard.seen if s[0] == "GET"))
        ok, why = _raises(lambda: client.task(FOREIGN), "wrong_product")
        check("t-boards: карточка чужого воркспейса — отказ", ok, why)
        ok, why = _raises(lambda: client.task("../../notebook/x/embed/work"), "bad_ref")
        check("t-boards: путь вне шаблонов (..) — отказ до сети", ok, why)
        FakeBoard.mode = {"429": 1, "retry_after": 1}
        check("t-boards: 429 с коротким Retry-After — одна пауза и повтор", client.task(TASK)["id"] == TASK
              and sleeps == [1.0])
        FakeBoard.mode = {"429": 1, "retry_after": 30}
        ok, why = _raises(lambda: client.task(TASK), "rate_limited")
        check("t-boards: 429 с долгим Retry-After — сразу отказ", ok and "30" in why, why)
        FakeBoard.mode = {"503": 1}
        check("t-boards: 503 — один повтор", client.meta(TASK)["kind"] == "bug")
        FakeBoard.mode = {"redirect": True}
        ok, why = _raises(lambda: client.task(TASK), "redirect")
        check("t-boards: переадресация не выполняется — ключ за ней не уходит",
              ok and not any("steal" in str(s[1]) for s in FakeBoard.seen), why)
        FakeBoard.mode = {}
    check("t-boards: клиент шлёт только GET и только с ключом",
          FakeBoard.seen and all(s[0] == "GET" and s[2] == KEY for s in FakeBoard.seen))
    with tb.Client(url, KEY, WS, budget=2) as client:
        client.task(TASK)
        client.meta(TASK)
        ok, why = _raises(lambda: client.comments(TASK), "budget")
        check("t-boards: бюджет запросов на вызов — отказ на третьем", ok, why)
    with tb.Client(url, KEY, WS) as client:
        ok, why = _raises(lambda: client.get("/api/nope"), "http_404")
        check("t-boards: 404 — понятный текст без тела ответа", ok and "nope" not in why, why)


def _card(check, tb, url: str, tmp: Path) -> None:
    from store import Store
    cfg = SimpleNamespace(get=lambda key, default=None: default)
    with tb.Client(url, KEY, WS, "aiboards-eval", "aiBoards&eval") as client:
        card = tb.fetch_card(cfg, "OPS-26", client)
    check("t-boards: card_id перенесённой карточки — её Notion-id с дефисами (история при ней)",
          card["card_id"] == "3b9dd207-a825-81df-b95a-df2a95472dbf" and card["board_task_id"] == TASK, card["card_id"])
    check("t-boards: поля — ошибка, P1, severity, ключ, адрес, модули ∩ канон",
          card["db"] == "bugs" and card["priority"] == "P1" and card["severity"] == "high"
          and card["ticket"] == "OPS-26" and card["url"].endswith("/aiboards-eval/task/OPS-26")
          and json.loads(card["modules"]) == ["backend"] and card["origin"] == "tboards", card)
    comments = json.loads(card["comments"])
    check("t-boards: e-mail, телефон и токен вычищены из тела, комментариев и отчёта; автора нет",
          "ivan.petrov@example.com" not in card["body"] and "916 123" not in card["body"]
          and "916 123" not in comments[0]["text"] and "sk-abcdef" not in (card["report"] or "")
          and set(comments[0]) == {"id", "text", "at"}, (card["body"], comments, card["report"]))
    done = tb.task_to_card(FakeBoard.task(TASK, status="выполненные"), {}, [], [], {"slug": "OPS"}, client)
    final = tb.task_to_card(FakeBoard.task(TASK, completedAt="2026-11-07"), {}, [], [], {"slug": "OPS"}, client)
    check("t-boards: финальная колонка — по slug и по completedAt", done["is_final"] == 1 and final["is_final"] == 1
          and done["card_id"] == TASK)

    store = Store(tmp / "tb.db")
    store.upsert_card({"card_id": "3b9dd207-a825-81df-b95a-df2a95472dbf", "db": "tasks", "title": "из Notion",
                       "content_hash": "old", "half_baked": 0})
    store.upsert_card({"card_id": "aaaa1111-a825-81df-b95a-df2a95472dbf", "db": "tasks", "title": "архив",
                       "half_baked": 0})
    store.upsert_card({"card_id": "draft_1", "db": "draft", "title": "черновик", "linked_card_ids": '["x"]',
                       "half_baked": 0})
    with tb.Client(url, KEY, WS, "aiboards-eval", "aiBoards&eval") as client:
        row = tb.fetch_into_store(cfg, store, "OPS-26", client)
    check("t-boards: строка снимка обновлена на месте (тот же card_id), а не дубль",
          row["origin"] == "tboards" and row["title"] == "Консилиум без Notion"
          and store.q1("SELECT COUNT(*) n FROM cards WHERE card_id LIKE '3b9dd207%'")["n"] == 1)
    open_ids = {c["card_id"] for c in store.open_cards()}
    check("t-boards: в работу — карточки t-boards и черновики, снимок Notion — нет",
          open_ids == {"3b9dd207-a825-81df-b95a-df2a95472dbf", "draft_1"}, open_ids)
    check("t-boards: поиск карточки по ключу и id t-boards",
          (store.find_card("ops-26") or {}).get("board_task_id") == TASK and store.find_card(TASK) is not None)
    store.upsert_card({**store.get_card("draft_1"), "linked_card_ids": None})
    check("t-boards: перечитывание не стирает @-связи черновика",
          store.get_card("draft_1")["linked_card_ids"] == '["x"]')
    check("t-boards: база закреплена за продуктом первой карточки",
          store.q1("SELECT value FROM council_state WHERE key = ?", (tb.PIN_KEY,))["value"] == WS)
    ok, why = _raises(lambda: tb.check_pin(store, OTHER_WS), "wrong_product")
    check("t-boards: ключ другого продукта на закреплённой базе — отказ", ok, why)
    store.close()


def _review(check, tb, url: str, tmp: Path) -> None:
    import review_service as svc
    from review_store import ReviewStore
    from store import Store
    db = tmp / "tb-review.db"
    store = Store(db)
    store.x("INSERT INTO review_cards (card_id, board, title, in_queue) VALUES ('notion-1', 'bugs', 'архив', 1)")
    store.x("DELETE FROM council_state WHERE key = 'migrate:review_notion_dequeued'")
    store.close()
    store = Store(db)
    check("ревью: однократно сняты с очереди карточки снимка Notion",
          store.q1("SELECT in_queue FROM review_cards WHERE card_id = 'notion-1'")["in_queue"] == 0)
    rs = ReviewStore(store)
    cfg = SimpleNamespace(get=lambda key, default=None: default)
    calls = []
    with tb.Client(url, KEY, WS, "aiboards-eval", "aiBoards&eval") as client:
        stats = svc.sync_queue(cfg, rs, client=client)
        calls.append(client.calls)
    queue = rs.queue()
    check("ревью: очередь из колонки in-review — ошибка и задача, half-baked помечена",
          {c["board"] for c in queue} == {"bugs", "tasks"} and stats["seen"] == 2 and not stats["partial"]
          and any(c["half_baked"] for c in queue), stats)
    with tb.Client(url, KEY, WS, "aiboards-eval", "aiBoards&eval") as client:
        again = svc.sync_queue(cfg, rs, client=client)
        calls.append(client.calls)
    check("ревью: неизменённые карточки не перечитываются (мета и комментарии)",
          again["fetched"] == 0 and calls[1] < calls[0], (again, calls))
    with tb.Client(url, KEY, WS, budget=1) as client:
        part = svc.sync_queue(cfg, rs, client=client)
    check("ревью: неполный проход (бюджет) ничего не снимает с очереди",
          part["partial"] and part["left"] == 0 and len(rs.queue()) == 2, part)
    found = rs.find_card("OPS-26")
    check("ревью: карточка очереди находится по ключу t-boards", found is not None and found["ticket"] == "OPS-26")
    check("ревью: по названию снимок Notion не находится", rs.find_card("архив") is None)
    store.close()


def _cli(check, tmp: Path) -> None:
    import supervisor
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        code = supervisor.cmd_run(SimpleNamespace(get=lambda k, d=None: d, cloud_enabled=lambda: False),
                                  SimpleNamespace(card="next", profile="fast", glm=False))
    check("run --card next: отказ с подсказкой (снимка нет)", code == 1 and "OPS-26" in err.getvalue(), err.getvalue())

    import gateway as gw
    import config as config_mod
    cfg = config_mod.load(strict=False)
    real_api = gw.Api
    gw.Api = lambda c: real_api(c, str(tmp / "tb.db"))
    out, sink = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            code = gw.get_once(cfg, "/api/runs?limit=1")
        with contextlib.redirect_stdout(sink):
            bad = gw.get_once(cfg, "/etc/passwd")
    finally:
        gw.Api = real_api
    check("MCP без шлюза: gateway.py --get отдаёт тот же JSON, только /api/…",
          code == 0 and isinstance(json.loads(out.getvalue()), list) and bad == 2, out.getvalue()[:200])


def run(tmp: Path, check) -> None:
    import tboards as tb
    print("\n30. t-boards по запросу: ключ продукта, только GET, карточка, очередь ревью (OPS-26)")
    with fake_board() as url:
        _key_and_url(check, tb, tmp, url)
        _client(check, tb, url)
        _card(check, tb, url, tmp)
        _review(check, tb, url, tmp)
    _cli(check, tmp)
