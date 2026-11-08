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
