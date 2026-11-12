"""Сводка карточек для очереди владельца (`cards_stats.py`, OPS-38): подсчёт, «в плане», история по дням.

Без сети: доска — подставной клиент, очередь не трогается. Запуск — из `selftest.py` (раздел 31).
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path


class FakeClient:
    """Две страницы проекта APP (финальная колонка и `completedAt` не считаются) и проект IS с одной ошибкой."""

    workspace = "ws1"

    def __init__(self):
        self.calls: list[tuple] = []

    def projects(self):
        return {"p-app": {"slug": "APP"}, "p-is": {"slug": "IS"}}

    def get(self, template, *segments, query=None):
        self.calls.append((template, segments, dict(query or {})))
        if template.startswith("/api/forest/"):
            return [{"taskId": "t3", "severity": "high"}] if query["projectId"] == "p-app" else \
                [{"taskId": "t9", "severity": ""}]
        if segments[0] == "p-app":
            if query["page"] == 1:
                return {"pagination": {"totalPages": 2}, "data": {"columns": [
                    {"slug": "to-do", "tasks": [{"id": "t1", "number": 1, "priority": "urgent"},
                                                {"id": "t2", "number": 2, "priority": "low"}]},
                    {"slug": "closed", "isFinal": True, "tasks": [{"id": "t8", "number": 8, "priority": "high"}]}]}}
            return {"pagination": {"totalPages": 2}, "data": {"columns": [
                {"slug": "in-review", "tasks": [{"id": "t3", "number": 3, "priority": "high"},
                                                {"id": "t4", "number": 4, "completedAt": "2026-11-01"}]},
                {"slug": "выполненные", "tasks": [{"id": "t5", "number": 5}]}]}}
        return {"pagination": {"totalPages": 1}, "data": {"columns": [
            {"slug": "new", "tasks": [{"id": "t9", "number": 9, "priority": ""}]}]}}


def run(tmp: Path, check) -> None:
    import cards_stats as cs
    print("\n31. сводка карточек t-boards для очереди владельца (OPS-38)")
    client = FakeClient()
    cards = cs.board_cards(client, {"done", "closed", "выполненные"})
    keys = sorted(c["key"] for c in cards)
    check("cards_stats: открытые — без финальной колонки, slug из final_slugs и completedAt",
          keys == ["APP-1", "APP-2", "APP-3", "IS-9"], str(keys))
    pages = [c for c in client.calls if c[0] == "/api/task/tasks/{}"]
    check("cards_stats: запрос на страницу проекта, а не на колонку (лимит ключа)", len(pages) == 3, str(len(pages)))
    work = [
        {"id": "w-open", "data": {"status": "doing", "cards": [{"key": "APP-1", "ws": "x"}, {"id": "notion32hex"}]}},
        {"id": "w-done", "data": {"status": "done", "cards": [{"key": "APP-2"}]}},
        {"id": "track-x", "data": {"kind": "track", "cards": [{"key": "IS-9"}]}},
    ]
    in_plan = cs.plan_keys(work)
    check("cards_stats: «в плане» — ключи открытых строк, не закрытых и не служебных", in_plan == {"APP-1"},
          str(in_plan))
    now = dt.datetime(2026, 11, 8, 21, 0, tzinfo=dt.timezone.utc)
    prev = {"history": [{"d": "2026-11-07", "bugs": 5, "tasks": 9, "inPlan": 1},
                        {"d": "2026-11-08", "bugs": 0, "tasks": 0, "inPlan": 0}]}
    st = cs.build_stats(cards, in_plan, prev, now)
    check("cards_stats: ошибки по severity, пустая — none", st["bugs"] == {"critical": 0, "high": 1, "medium": 0,
                                                                          "low": 0, "none": 1}, str(st["bugs"]))
    check("cards_stats: задачи по приоритету P0…P3", st["tasks"] == {"P0": 1, "P1": 0, "P2": 0, "P3": 1, "none": 0},
          str(st["tasks"]))
    check("cards_stats: inPlan и notInPlan", (st["inPlan"], st["notInPlan"]) == (1, 3), f"{st['inPlan']}/{st['notInPlan']}")
    check("cards_stats: одна точка истории на день, старые дни остаются",
          st["history"] == [{"d": "2026-11-07", "bugs": 5, "tasks": 9, "inPlan": 1},
                            {"d": "2026-11-08", "bugs": 2, "tasks": 2, "inPlan": 1}], str(st["history"]))
    check("cards_stats: формат страницы — kind stats и время UTC", st["kind"] == "stats" and st["at"].endswith("Z"),
          st["at"])
    run_failures(check)
    run_boards(check)


def run_failures(check) -> None:
    """Сбой сети — одна строка и код 1; прошлая сводка — отдельным чтением по id (история не теряется)."""
    import os
    import cards_stats as cs
    saved = cs.OQ_URL
    cs.OQ_URL = "https://127.0.0.1:9/api/oq/v1"
    try:
        cs.queue_call("GET", "/db/work", "x")
        check("cards_stats: сбой сети — SystemExit с причиной", False, "нет исключения")
    except SystemExit as exc:
        check("cards_stats: сбой сети — SystemExit с причиной", str(exc).startswith("очередь недоступна"), str(exc))
    finally:
        cs.OQ_URL = saved
    calls: list[tuple] = []
    real = cs.queue_call

    def fake(method, path, token, body=None):
        calls.append((method, path, (body or {}).get("ifVersion")))
        if method == "PUT":
            return {"version": 8}
        if path == "/db/work":
            return {"docs": [{"id": "w-open", "data": {"status": "doing", "cards": []}}]}
        if path == f"/db/work/{cs.DOC_ID}":
            return {"id": cs.DOC_ID, "version": 7, "data": {"history": [{"d": "2026-11-01", "bugs": 1, "tasks": 1,
                                                                            "inPlan": 0}]}}
        return {}

    class Client(FakeClient):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    saved_build, saved_token = cs.tboards.build, cs.queue_token
    cs.queue_call, cs.tboards.build, cs.queue_token = fake, (lambda *a, **k: Client()), (lambda: "x")
    os.environ.setdefault("TAIBE_HOST_ROOT", str(cs.config_mod.REPO_ROOT))
    try:
        rc = cs.main(["--write"])
    finally:
        cs.queue_call, cs.tboards.build, cs.queue_token = real, saved_build, saved_token
    put = [c for c in calls if c[0] == "PUT"]
    check("cards_stats: прошлая сводка читается по id, запись с её ifVersion",
          rc == 0 and ("GET", f"/db/work/{cs.DOC_ID}", None) in calls and put == [("PUT", f"/db/work/{cs.DOC_ID}", 7)],
          str(calls))


class BoardsClient:
    """Доска с двумя проектами, деревом из корня и ветки и двумя секторами; бюджет — на два дерева."""

    workspace, slug, name = "ws-id", "aiboards-eval", "aiBoards&eval"

    def __init__(self, budget=95):
        self.calls, self.budget = 0, budget

    def projects(self):
        return {"p-ops": {"slug": "OPS", "name": "Инфраструктура"}, "p-tb": {"slug": "TB", "name": "t-boards"}}

    def get(self, template, *segments, query=None):
        self.calls += 1
        if template == "/api/forest/{}/trees":
            return {"trees": [{"id": "r1", "number": 34, "projectSlug": "OPS"},
                              {"id": "r2", "number": 7, "projectSlug": "TB"}], "truncated": False}
        if template == "/api/forest/{}/sectors":
            assert query == {"status": "active"}
            return [{"id": "s1", "name": "Sector: Очередь владельца: короткие ответы +1", "treeIds": ["r1"]},
                    {"id": "s2", "name": "Sector: Доски", "treeIds": ["r2"]}]
        if template == "/api/forest/{}/trees/{}" and segments[1] == "r1":
            return {"rootId": "r1", "branches": [{"id": "r1", "number": 34, "projectId": "p-ops"},
                                                 {"id": "b1", "number": 40, "projectId": "p-tb"}], "truncated": False}
        return {"rootId": segments[-1], "branches": [{"id": "r2", "number": 7, "projectId": "p-tb"}]}


def run_boards(check) -> None:
    """Доска продукта по GET /products и карта доски для группировки «Хода работ» по проектам и секторам."""
    import cards_stats as cs
    meta = {"default": "hr-helper", "products": [{"slug": "hr-helper", "boards": ["hr-helper-lavaeon"]},
                                                 {"slug": "taibe", "boards": ["aiboards-eval"]}]}
    check("cards_stats: доска продукта по умолчанию — прежний cards-stats, другая — свой id",
          (cs.board_target(meta, "hr-helper-lavaeon"), cs.board_target(meta, "aiboards-eval"))
          == (("cards-stats", True), ("cards-stats-aiboards-eval", True)), "")
    check("cards_stats: консоль без boards — как раньше, один cards-stats без карты",
          cs.board_target({"products": [{"slug": "hr-helper", "name": "x"}]}, "aiboards-eval") == ("cards-stats", False), "")
    check("cards_stats: имя сектора без «Sector:» и «+N»",
          cs.sector_name("Sector: Миграция считается применённой +15") == "Миграция считается применённой", "")
    now = dt.datetime(2026, 11, 10, 20, 0, tzinfo=dt.timezone.utc)
    m = cs.board_map(BoardsClient(), now)
    check("cards_stats: карта доски — проекты, секторы с ключами корня и веток",
          m["projects"] == [{"slug": "OPS", "name": "Инфраструктура"}, {"slug": "TB", "name": "t-boards"}]
          and m["sectors"] == [{"id": "s1", "name": "Очередь владельца: короткие ответы", "keys": ["OPS-34", "TB-40"]},
                               {"id": "s2", "name": "Доски", "keys": ["TB-7"]}]
          and (m["kind"], m["ws"], m["partial"]) == ("boards", "aiboards-eval", False), str(m))
    tight = cs.board_map(BoardsClient(budget=5), now)
    check("cards_stats: бюджет ключа кончился — у сектора только корень, partial",
          tight["sectors"][1]["keys"] == ["TB-7"] and tight["sectors"][0]["keys"] == ["OPS-34", "TB-40"]
          and tight["partial"] is True, str(tight["sectors"]))
    calls: list[tuple] = []
    real = cs.queue_call

    def fake(method, path, token, body=None):
        calls.append((method, path, (body or {}).get("data", {}).get("kind"), (body or {}).get("data", {}).get("ws")))
        if path == "/products":
            return meta
        if method == "PUT":
            return {"version": 1}
        return {"docs": []} if path == "/db/work" else {}

    class Client(BoardsClient):
        """Карточки — как у FakeClient, деревья и секторы — как у BoardsClient; calls — число запросов."""

        def __init__(self):
            super().__init__()
            self.cards = FakeClient()

        def get(self, template, *segments, query=None):
            if template.startswith("/api/forest/{}/trees") or template == "/api/forest/{}/sectors":
                return super().get(template, *segments, query=query)
            self.calls += 1
            return self.cards.get(template, *segments, query=query)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    saved_build, saved_token = cs.tboards.build, cs.queue_token
    cs.queue_call, cs.tboards.build, cs.queue_token = fake, (lambda *a, **k: Client()), (lambda: "x")
    try:
        rc = cs.main(["--write"])
    finally:
        cs.queue_call, cs.tboards.build, cs.queue_token = real, saved_build, saved_token
    puts = [c for c in calls if c[0] == "PUT"]
    check("cards_stats: доска tAIBE — своя сводка с ws и карта доски",
          rc == 0 and puts == [("PUT", "/db/work/cards-stats-aiboards-eval", "stats", "aiboards-eval"),
                               ("PUT", "/db/work/boards-aiboards-eval", "boards", "aiboards-eval")], str(puts))
