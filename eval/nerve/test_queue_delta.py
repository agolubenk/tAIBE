# -*- coding: utf-8 -*-
"""Нерв на дельте очереди (OPS-50, HR #623 — GET /api/oq/v1/changes): полный список один раз, дальше — изменения после
курсора; 410 — полный список в том же проходе; старая консоль без /changes или сбой — прежний /db/:col и пауза;
полный список раз в 12 ч. Применённые дельты дают тот же список, что полный. Фальшивая консоль — без сети.
python3 -I -m unittest discover -s eval/nerve -p 'test_*.py'"""
import copy
import json
import os
import sys
import tempfile
import unittest
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sources  # noqa: E402
from journal import read_from  # noqa: E402
from test_queue_poll import TOKEN, QueueCtx, _item  # noqa: E402


class FakeConsole:
    """Консоль с журналом событий: /changes (полный список, дельта, 410) и прежний /db/:col. Курсор — «b.<n>»."""

    def __init__(self, items, checks, changes=True):
        self.docs = {"items": {d["id"]: d for d in items}, "checks": {d["id"]: d for d in checks}}
        self.log = []                 # (n, col, id) — журнал событий
        self.changes, self.force410, self.calls, self.n = changes, False, [], 0

    def write(self, col, doc):
        self.n += 1
        self.docs[col][doc["id"]] = dict(doc, updatedAt=self.n)
        self.log.append((self.n, col, doc["id"]))

    def delete(self, col, doc_id):
        self.n += 1
        self.docs[col].pop(doc_id, None)
        self.log.append((self.n, col, doc_id))

    def full(self, col):
        return sorted(self.docs[col].values(), key=lambda d: d.get("updatedAt") or 0, reverse=True)

    def __call__(self, cmd, stdin=None, timeout=30):  # noqa: ARG002 — сигнатура sources.run
        del timeout
        url = cmd[-1]
        self.calls.append((list(cmd), stdin, url))
        parts = urlsplit(url)
        if parts.path.endswith("/changes"):
            if not self.changes:
                return 0, '{"error":"not found"}\n404 20 100 80', ""
            q = parse_qs(parts.query)
            cols = q["col"][0].split(",")
            if "since" not in q:
                body = {"full": True, "cursor": f"b.{self.n}", "collections": {c: {"docs": self.full(c)} for c in cols}}
                return 0, f"{json.dumps(body)}\n200 {len(json.dumps(body)) // 4} 300 80", ""
            since = int(q["since"][0].split(".")[1])
            if self.force410:
                return 0, '{"resync":true}\n410 16 100 80', ""
            changes = {}
            for c in cols:
                ids = sorted({i for n, col, i in self.log if n > since and col == c})
                changes[c] = {"docs": [self.docs[c][i] for i in ids if i in self.docs[c]],
                              "removed": [i for i in ids if i not in self.docs[c]]}
            body = json.dumps({"cursor": f"b.{self.n}", "changes": changes})
            return 0, f"{body}\n200 {len(body) // 4} 200 80", ""
        col = parts.path.rsplit("/", 1)[1]
        body = json.dumps({"docs": self.full(col)})
        return 0, f"{body}\n200 {len(body) // 4} 300 80 ", ""

    def paths(self, start=0):
        return [("changes" if "/changes" in u else "db") + ("+since" if "since=" in u else "") for _, _, u in self.calls[start:]]


def _answer(i, at):
    return {"id": f"d-{i}", "version": 1, "data": {"choice": "yes", "done": True, "at": at}}


class QueueDeltaTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.ctx = QueueCtx(self.d)
        self.ctx.cfg = copy.deepcopy(self.ctx.cfg)
        self.ctx.cfg["queue"]["delta"] = True
        self._run = sources.run
        self.addCleanup(setattr, sources, "run", self._run)
        for cache in (sources._OQ_CACHE, sources._OQ_DELTA):
            cache.clear()
            self.addCleanup(cache.clear)
        self.console = FakeConsole([_item(1), _item(2)], [_answer(1, "2026-10-28T07:00:00Z")])
        sources.run = self.console

    def events(self, kind):
        return [e for e in read_from(os.path.join(self.d, "j.jsonl"), 0)[0] if e["kind"] == kind]

    def view(self):
        return {c: sorted((d["id"], d.get("updatedAt")) for d in docs) for c, (docs, _) in sources._oq_lists(self.ctx).items()}

    def test_full_once_then_one_delta_call_per_poll(self):
        sources.poll_queue(self.ctx)
        self.assertEqual(self.console.paths(), ["changes"])
        self.assertEqual(len(self.events("owner.answer")), 1)
        sources.poll_queue(self.ctx)
        self.assertEqual(self.console.paths(1), ["changes+since"])
        self.assertEqual(len(self.events("owner.answer")), 1, "пустая дельта — тот же ответ, без дубля")
        cmd, stdin, url = self.console.calls[1]
        self.assertNotIn(TOKEN, " ".join(cmd), "токен — только через stdin")
        self.assertIn(f"Bearer {TOKEN}", stdin)
        self.assertIn("since=b.0", url)
        self.assertIn("--compressed", cmd)
        self.assertNotIn("-f", cmd, "без -f: 410 — ответ, а не сбой curl")
        self.assertEqual(self.ctx.state["queue"]["bytes"]["calls"], 2)

    def test_delta_brings_new_answer_and_removal(self):
        sources.poll_queue(self.ctx)
        self.console.write("checks", _answer(2, "2026-10-28T08:00:00Z"))
        self.console.delete("items", "d-1")
        sources.poll_queue(self.ctx)
        answers = self.events("owner.answer")
        self.assertEqual([e["key"].split(":")[2] for e in answers], ["d-1", "d-2"])
        self.assertEqual([d for d, _ in self.view()["items"]], ["d-2"])
        # Курсор двигается: следующая дельта — от последнего события, а не от первого полного списка.
        self.assertIn("since=b.2", self.console.calls[-1][2])

    def test_applied_deltas_equal_the_full_list(self):
        self.view()
        for step in range(5):
            self.console.write("items", _item(10 + step))
            self.console.write("items", _item(1, title=f"правка {step}"))
            if step == 2:
                self.console.delete("items", "d-2")
            self.console.write("checks", _answer(10 + step, f"2026-10-28T0{step}:00:00Z"))
            got = self.view()
            want = {c: sorted((d["id"], d.get("updatedAt")) for d in self.console.full(c)) for c in ("checks", "items")}
            self.assertEqual(got, want, f"шаг {step}")
        self.assertEqual(self.console.paths().count("changes"), 1, "полный список — один раз")

    def test_410_takes_the_full_list_in_the_same_poll(self):
        self.view()
        self.console.force410 = True
        self.console.write("items", _item(3))
        self.assertIn("d-3", [d for d, _ in self.view()["items"]])
        self.assertEqual(self.console.paths(1), ["changes+since", "changes"])
        self.console.force410 = False
        self.view()
        self.assertEqual(self.console.paths(3), ["changes+since"])

    def test_old_console_without_changes_falls_back_and_pauses(self):
        self.console.changes = False
        sources.poll_queue(self.ctx)
        self.assertEqual(self.console.paths(), ["changes", "db", "db"])
        self.assertEqual(len(self.events("owner.answer")), 1, "прежний список в том же проходе")
        self.assertEqual(len(self.events("queue.delta")), 1)
        self.ctx.now += timedelta(minutes=10)
        sources.poll_queue(self.ctx)
        self.assertEqual(self.console.paths(3), ["db", "db"], "пауза: /changes не дёргается")
        self.console.changes = True
        self.ctx.now += timedelta(minutes=25)
        sources.poll_queue(self.ctx)
        self.assertEqual(self.console.paths(5), ["changes"], "после паузы — снова дельта")
        self.assertEqual(len(self.events("queue.delta")), 1, "сводка о сбое — раз в сутки")

    def test_broken_body_falls_back(self):
        def broken(cmd, stdin=None, timeout=30):
            if "/changes" in cmd[-1]:
                return 0, "not json\n200 8 100 80", ""
            return self.console(cmd, stdin, timeout)
        sources.run = broken
        self.assertEqual([d for d, _ in self.view()["items"]], ["d-1", "d-2"])

    def test_full_list_again_after_12_hours(self):
        self.view()
        self.ctx.now += timedelta(hours=11)
        self.view()
        self.ctx.now += timedelta(hours=1, minutes=1)
        self.view()
        self.assertEqual(self.console.paths(), ["changes", "changes+since", "changes"])

    def test_delta_off_uses_the_old_list(self):
        self.ctx.cfg["queue"]["delta"] = False
        sources.poll_queue(self.ctx)
        self.assertEqual(self.console.paths(), ["db", "db"])

    def test_capped_full_list_keeps_meta(self):
        orig = self.console.full

        def capped(col):
            return orig(col)[:1] if col == "items" else orig(col)
        self.console.full = capped
        real = self.console.__call__

        def call(cmd, stdin=None, timeout=30):
            code, out, err = real(cmd, stdin, timeout)
            if "/changes" in cmd[-1] and "since=" not in cmd[-1]:
                body, _, tail = out.rpartition("\n")
                j = json.loads(body)
                j["collections"]["items"].update(truncated=True, total=2, limit=1)
                out = f"{json.dumps(j)}\n{tail}"
            return code, out, err
        sources.run = call
        lists = sources._oq_lists(self.ctx)
        self.assertEqual(lists["items"][1], {"total": 2, "limit": 1})
        self.assertEqual(lists["checks"][1], {})


if __name__ == "__main__":
    unittest.main()
