# -*- coding: utf-8 -*-
"""Опрос очереди владельца Нервом: условный сжатый запрос (ETag/304 из памяти процесса), счётчик байт по дням,
сигналы о потолке списка. python3 -I -m unittest discover -s eval/nerve -p 'test_*.py'"""
import json
import os
import sys
import tempfile
import unittest
from datetime import timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import sources  # noqa: E402
from journal import DIGEST, NERVOUS, read_from  # noqa: E402
from test_nerve import FakeCtx  # noqa: E402

TOKEN = "tok-secret"


class QueueCtx(FakeCtx):
    def oq_token(self):
        return TOKEN


class FakeCurl:
    """Подмена sources.run для curl консоли: тег коллекции — W/"<col>-<rev>" (как у сжатого ответа); совпал — 304."""

    def __init__(self, docs, extra=None, tag_fmt='W/"{col}-{rev}"'):
        self.docs, self.extra, self.tag_fmt = docs, extra or {}, tag_fmt
        self.rev = {col: 1 for col in docs}
        self.calls = []

    def __call__(self, cmd, stdin=None, timeout=30):  # noqa: ARG002 — сигнатура sources.run
        del timeout
        col = cmd[-1].rsplit("/", 1)[1]
        self.calls.append((list(cmd), stdin, col))
        tag = self.tag_fmt.format(col=col, rev=self.rev[col])
        sent = next((ln.split(": ", 1)[1] for ln in (stdin or "").splitlines() if ln.startswith("If-None-Match: ")), None)
        if sent == tag:
            return 0, f"\n304 0 120 80 {tag}", ""
        body = json.dumps({"docs": self.docs[col], **self.extra.get(col, {})})
        return 0, f"{body}\n200 {len(body) // 4} 300 80 {tag}", ""


def _item(i, **data):
    return {"id": f"d-{i}", "version": 1, "data": {"kind": "decision", "title": f"Решение {i}", "source": "Контроль", **data}}


class QueuePollTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.ctx = QueueCtx(self.d)
        env = {"TAIBE_LINEAGE_DIR": os.path.join(self.d, "lineage")}  # метки surplus — свои, не настоящие Mac
        old = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        self.addCleanup(lambda: [os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
                                 for k, v in old.items()])
        self._run = sources.run
        self.addCleanup(setattr, sources, "run", self._run)
        sources._OQ_CACHE.clear()
        self.addCleanup(sources._OQ_CACHE.clear)

    def events(self):
        return read_from(os.path.join(self.d, "j.jsonl"), 0)[0]

    def test_second_poll_is_conditional_and_reuses_docs(self):
        check = {"id": "d-1", "version": 2, "data": {"choice": "yes", "done": True, "at": "2026-10-28T07:00:00Z"}}
        fake = FakeCurl({"items": [_item(1)], "checks": [check]})
        sources.run = fake
        sources.poll_queue(self.ctx)
        first = [e for e in self.events() if e["kind"] == "owner.answer"]
        self.assertEqual(len(first), 1)
        cmd, stdin, _ = fake.calls[0]
        self.assertIn("--compressed", cmd)
        self.assertNotIn(TOKEN, " ".join(cmd), "токен — только через stdin, не в argv")
        self.assertNotIn("If-None-Match", stdin)

        sources.poll_queue(self.ctx)
        for _, stdin, col in fake.calls[2:]:
            self.assertIn(f'If-None-Match: W/"{col}-1"', stdin)
        # 304: те же документы из памяти — ответ владельца по-прежнему виден, журнал его не дублирует.
        self.assertEqual(len([e for e in self.events() if e["kind"] == "owner.answer"]), 1)
        b = self.ctx.state["queue"]["bytes"]
        self.assertEqual(b["calls"], 4)
        full = sum(len(json.dumps({"docs": d})) // 4 + 300 + 80 for d in fake.docs.values())
        self.assertEqual(b["n"], full + 2 * (120 + 80), "сжатое тело, заголовки и запрос; у 304 — без тела")

        fake.rev["checks"] = 2
        fake.docs["checks"] = []
        sources.poll_queue(self.ctx)
        self.assertNotIn("If-None-Match", fake.calls[-1][1].replace('If-None-Match: W/"checks-1"', ""))
        self.assertEqual(sources._OQ_CACHE[next(k for k in sources._OQ_CACHE if k.endswith("/checks"))][0], 'W/"checks-2"')

    def test_team_split_answer_wakes_no_role(self):
        """Доли команды ролей (OPS-82) переключает кнопка «Роли» в шапке /queue — ответ читает сторож Mac, не роль."""
        self.ctx.cfg["system"] = {"team": {"split_item": "d-team-split"}}
        split = {"id": "d-team-split", "version": 1, "data": {"kind": "decision", "title": "Доли", "source": "taibe"}}
        checks = [{"id": "d-team-split", "version": 3, "data": {"choice": "pause", "done": True, "at": "2026-10-28T07:00:00Z"}},
                  {"id": "d-1", "version": 2, "data": {"choice": "yes", "done": True, "at": "2026-10-28T07:00:00Z"}}]
        sources.run = FakeCurl({"items": [split, _item(1)], "checks": checks})
        sources.poll_queue(self.ctx)
        self.assertEqual([e["text"] for e in self.events() if e["kind"] == "owner.answer"], ["ответ владельца d-1: yes"])

    def test_answer_to_role_without_session_also_goes_to_coord(self):
        """d-team-surplus-1711: роль-автор закончила смену сверх доли — ответ владельца и координатору."""
        check = {"id": "d-1", "version": 2, "data": {"choice": "yes", "done": True, "at": "2026-10-28T07:00:00Z"}}
        sources.run = FakeCurl({"items": [_item(1)], "checks": [check]})  # source «Контроль» → release
        real = sources.map_roles
        self.addCleanup(setattr, sources, "map_roles", real)
        sources.map_roles = lambda ctx: {"coord": ("x", 0), "plan": ("y", 0)}
        sources.poll_queue(self.ctx)
        ev = [e for e in self.events() if e["kind"] == "owner.answer"]
        self.assertEqual(sorted(ev[0]["to"]), ["coord", "release"])
        self.assertIn("роль release без сессии", ev[0]["text"])

    def test_answer_to_surplus_role_goes_to_coord_at_once(self):
        """Роль сверх доли закончила смену час назад: её транскрипт ещё «активен» (8 ч), но метка surplus говорит — нет."""
        os.makedirs(os.environ["TAIBE_LINEAGE_DIR"], exist_ok=True)
        with open(os.path.join(os.environ["TAIBE_LINEAGE_DIR"], "r.ab.surplus"), "w", encoding="utf-8") as f:
            json.dump({"line": "r.ab", "role": "release", "product": ""}, f)
        now = self.ctx.now.timestamp()
        os.utime(os.path.join(os.environ["TAIBE_LINEAGE_DIR"], "r.ab.surplus"), (now - 3600, now - 3600))
        check = {"id": "d-1", "version": 2, "data": {"choice": "yes", "done": True, "at": "2026-10-28T07:00:00Z"}}
        sources.run = FakeCurl({"items": [_item(1)], "checks": [check]})
        real = sources.map_roles
        self.addCleanup(setattr, sources, "map_roles", real)
        sources.map_roles = lambda ctx: {"release": ("x", 0), "coord": ("y", 0)}
        sources.poll_queue(self.ctx)
        ev = [e for e in self.events() if e["kind"] == "owner.answer"]
        self.assertEqual(sorted(ev[0]["to"]), ["coord", "release"])

    def test_answer_to_live_role_or_when_nobody_is_live_stays_with_the_role(self):
        check = {"id": "d-1", "version": 2, "data": {"choice": "yes", "done": True, "at": "2026-10-28T07:00:00Z"}}
        real = sources.map_roles
        self.addCleanup(setattr, sources, "map_roles", real)
        for live in ({"release": ("x", 0)}, {}):
            sources._OQ_CACHE.clear()
            self.ctx.state = {}
            sources.run = FakeCurl({"items": [_item(1)], "checks": [check]})
            sources.map_roles = lambda ctx, live=live: live
            d = tempfile.mkdtemp()
            self.ctx = QueueCtx(d)
            self.d = d
            sources.poll_queue(self.ctx)
            ev = [e for e in self.events() if e["kind"] == "owner.answer"]
            self.assertEqual(ev[0]["to"], ["release"], live)

    def test_bytes_roll_over_by_local_day(self):
        sources.run = FakeCurl({"items": [], "checks": []})
        sources.poll_queue(self.ctx)
        day1 = self.ctx.state["queue"]["bytes"]["day"]
        self.assertEqual(day1, "2026-10-28")
        n1 = self.ctx.state["queue"]["bytes"]["n"]
        self.ctx.now += timedelta(hours=14)  # 10:53 МСК + 14 ч — следующие сутки по МСК
        sources.poll_queue(self.ctx)
        b = self.ctx.state["queue"]["bytes"]
        self.assertEqual(b["day"], "2026-10-29")
        self.assertEqual(b["prev"], {"day": "2026-10-28", "n": n1, "calls": 2})
        self.assertEqual(b["calls"], 2)

    def test_server_cap_is_nervous_for_release_once_a_day_and_survives_304(self):
        sources.run = FakeCurl({"items": [_item(1)], "checks": []}, extra={"items": {"truncated": True, "total": 12000, "limit": 10000}})
        sources.poll_queue(self.ctx)
        sources.poll_queue(self.ctx)  # 304 — meta из памяти, сигнал не мигает и не дублируется
        capped = [e for e in self.events() if e["kind"] == "queue.capped"]
        self.assertEqual(len(capped), 1)
        self.assertEqual((capped[0]["class"], capped[0]["to"]), (NERVOUS, ["release"]))
        self.assertIn("10000 из 12000", capped[0]["text"])
        _, meta = sources._oq_get(self.ctx, "items")
        self.assertEqual(meta, {"total": 12000, "limit": 10000})

    def test_bytes_over_threshold_digest_once_for_previous_day(self):
        # cfg у FakeCtx общий на все тесты — порог только в копии.
        self.ctx.cfg = {**self.ctx.cfg, "queue": {**self.ctx.cfg["queue"], "bytes_warn": 100}}
        sources.run = FakeCurl({"items": [_item(1)], "checks": []})
        sources.poll_queue(self.ctx)
        self.assertFalse([e for e in self.events() if e["kind"] == "queue.bytes"], "итог — только за прошедшие сутки")
        self.ctx.now += timedelta(hours=14)
        sources.poll_queue(self.ctx)
        sources.poll_queue(self.ctx)
        self.ctx.now += timedelta(days=1)  # следующие сутки той же недели — без повтора
        sources.poll_queue(self.ctx)
        ev = [e for e in self.events() if e["kind"] == "queue.bytes"]
        self.assertEqual([(e["key"], e["class"], e["to"]) for e in ev], [("oq:bytes:2026-W44", DIGEST, ["release"])])
        self.assertIn("за 2026-10-28", ev[0]["text"])

    def test_bytes_under_threshold_is_silent(self):
        sources.run = FakeCurl({"items": [_item(1)], "checks": []})
        sources.poll_queue(self.ctx)
        self.ctx.now += timedelta(hours=14)
        sources.poll_queue(self.ctx)
        self.assertFalse([e for e in self.events() if e["kind"] == "queue.bytes"])

    def test_tag_with_control_chars_is_not_sent_back(self):
        fake = FakeCurl({"items": [], "checks": []}, tag_fmt='W/"{col}\rX-Evil: 1"')  # LF до тега не доходит (rpartition), CR — да
        sources.run = fake
        sources.poll_queue(self.ctx)
        sources.poll_queue(self.ctx)
        self.assertFalse(any("If-None-Match" in (stdin or "") for _, stdin, _ in fake.calls))

    def test_old_curl_without_header_var_polls_unconditionally(self):
        fake = FakeCurl({"items": [], "checks": []}, tag_fmt="%header{{etag}}")
        sources.run = fake
        sources.poll_queue(self.ctx)
        sources.poll_queue(self.ctx)
        self.assertFalse(any("If-None-Match" in (stdin or "") for _, stdin, _ in fake.calls))
        self.assertEqual(sources._OQ_CACHE, {})


if __name__ == "__main__":
    unittest.main()
