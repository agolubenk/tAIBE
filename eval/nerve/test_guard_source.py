# -*- coding: utf-8 -*-
"""Читатель прогонов сторожей (TB-45, S45-4b): курсор, 304, попытки, сопоставление workflow → карточка."""
import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import guard_source  # noqa: E402
import sources  # noqa: E402

REPO, BRANCH = "o/r", "board-agents"
T0 = datetime(2026, 11, 15, 0, 30, tzinfo=timezone.utc)
ETAG = 'W/"e1"'


def _run(rid, created, status="completed", conclusion="success", path=".github/workflows/eval-ci.yml", attempt=1):
    return {"id": rid, "run_attempt": attempt, "path": path, "name": "eval CI", "run_number": rid,
            "status": status, "conclusion": conclusion if status == "completed" else None,
            "html_url": f"https://github.com/{REPO}/actions/runs/{rid}", "head_sha": "a" * 40,
            "created_at": created, "updated_at": created.replace(":00Z", ":59Z")}


class FakeRuns:
    """Подмена sources.run для `gh api -i …/actions/runs`: отдаёт runs, на совпавший If-None-Match — 304."""

    def __init__(self, runs, etag=ETAG, total=None, fail=False):
        self.runs, self.etag, self.total, self.fail = runs, etag, total, fail
        self.calls = []

    def __call__(self, cmd, stdin=None, timeout=30):
        self.calls.append(list(cmd))
        if cmd[:3] != ["gh", "api", "-i"] or f"repos/{REPO}/actions/runs?" not in cmd[-1]:
            raise AssertionError(f"неожиданный вызов: {cmd}")
        if self.fail:
            return 1, "", "HTTP 502: Bad Gateway"
        if "-H" in cmd and cmd[cmd.index("-H") + 1] == f"If-None-Match: {self.etag}":
            return 1, "HTTP/2.0 304 Not Modified\r\nEtag: x\r\n\r\n", "gh: HTTP 304"
        body = json.dumps({"total_count": self.total or len(self.runs), "workflow_runs": self.runs})
        return 0, f"HTTP/2.0 200 OK\nEtag: {self.etag}\r\nX-Other: 1\r\n\r\n{body}", ""


class Ctx:
    def __init__(self):
        self.now = T0
        self.state = {}


class ReadResultsTest(unittest.TestCase):
    def setUp(self):
        self._run = sources.run
        self.addCleanup(setattr, sources, "run", self._run)
        self.ctx = Ctx()

    def read(self, fake, after=0):
        sources.run = fake
        self.ctx.now = T0 + timedelta(seconds=after)
        return guard_source.read_results(self.ctx, REPO, BRANCH)

    def query(self, call):
        return call[-1].split("?", 1)[1]

    def test_first_read_takes_last_hour_and_skips_non_results(self):
        fake = FakeRuns([_run(3, "2026-11-15T00:20:00Z", conclusion="failure"),
                         _run(2, "2026-11-15T00:10:00Z", conclusion="cancelled"),
                         _run(1, "2026-11-15T00:05:00Z")])
        out, skipped = self.read(fake)
        self.assertIn("created=%3E%3D2026-11-14T23%3A30%3A00Z", self.query(fake.calls[0]))
        self.assertIn("branch=board-agents", self.query(fake.calls[0]))
        self.assertEqual([(p, b["status"], b["runUrl"].rsplit("/", 1)[1]) for p, b in out],
                         [(".github/workflows/eval-ci.yml", "red", "3"), (".github/workflows/eval-ci.yml", "green", "1")])
        self.assertEqual(skipped, 0)
        body = out[0][1]
        self.assertEqual((body["source"], body["ranAt"]), ("nerve", "2026-11-15T00:20:59Z"))
        self.assertEqual(body["summary"], "eval CI #3: failure на aaaaaaaaa (board-agents)")
        self.assertEqual(self.ctx.state["guard"]["since"], "2026-11-15T00:20:00Z")

    def test_pending_run_holds_the_cursor_and_is_sent_once_done(self):
        out, _ = self.read(FakeRuns([_run(4, "2026-11-15T00:25:00Z"),
                                     _run(5, "2026-11-15T00:15:00Z", status="in_progress")]))
        self.assertEqual([b["runUrl"][-1] for _, b in out], ["4"])
        self.assertEqual(self.ctx.state["guard"]["since"], "2026-11-15T00:15:00Z")
        fake = FakeRuns([_run(4, "2026-11-15T00:25:00Z"), _run(5, "2026-11-15T00:15:00Z", conclusion="failure")],
                        etag='W/"e2"')
        out, _ = self.read(fake, after=300)
        self.assertIn("created=%3E%3D2026-11-15T00%3A15%3A00Z", self.query(fake.calls[0]))
        self.assertEqual([(b["status"], b["runUrl"][-1]) for _, b in out], [("red", "5")])
        st = self.ctx.state["guard"]
        self.assertEqual((st["since"], sorted(st["seen"])), ("2026-11-15T00:25:00Z", ["4:1"]))

    def test_cursor_is_the_oldest_pending_run(self):
        runs = [{"status": "completed", "created": "2026-11-15T00:25:00Z"},
                {"status": "in_progress", "created": "2026-11-15T00:20:00Z"},
                {"status": "queued", "created": "2026-11-15T00:10:00Z"}]
        self.assertEqual(guard_source.next_since(runs, "2026-11-15T00:00:00Z", T0), "2026-11-15T00:10:00Z")
        self.assertEqual(guard_source.next_since([], "2026-11-15T00:05:00Z", T0), "2026-11-15T00:05:00Z")

    def test_same_query_goes_with_etag_and_304_changes_nothing(self):
        runs = [_run(1, "2026-11-15T00:05:00Z")]
        self.read(FakeRuns(runs, etag='W/"e0"'))   # курсор сдвинулся: etag того запроса к новому не подходит
        second = FakeRuns(runs)
        self.read(second, after=300)
        self.assertNotIn("-H", second.calls[0])
        before = {k: v for k, v in self.ctx.state["guard"].items() if k != "at"}
        fake = FakeRuns(runs)
        fake.runs = []   # тело на 304 не читается
        out, skipped = self.read(fake, after=600)
        self.assertEqual((out, skipped), ([], 0))
        self.assertEqual(fake.calls[0][3:5], ["-H", f"If-None-Match: {ETAG}"])
        st = dict(self.ctx.state["guard"])
        self.assertEqual(st.pop("at"), "2026-11-15T00:40:00Z")
        self.assertEqual(st, before)

    def test_repeat_read_does_not_resend_a_seen_run(self):
        runs = [_run(1, "2026-11-15T00:05:00Z")]
        self.read(FakeRuns(runs))
        out, _ = self.read(FakeRuns(runs, etag='W/"e9"'), after=300)
        self.assertEqual(out, [])

    def test_reads_no_more_often_than_guard_every(self):
        self.read(FakeRuns([]))
        fake = FakeRuns([])
        self.assertEqual(self.read(fake, after=guard_source.GUARD_EVERY - 1), ([], 0))
        self.assertEqual(fake.calls, [])
        self.read(fake, after=guard_source.GUARD_EVERY)
        self.assertEqual(len(fake.calls), 1)

    def test_rerun_attempt_is_a_new_run_with_its_own_url(self):
        self.read(FakeRuns([_run(7, "2026-11-15T00:05:00Z", conclusion="failure")]))
        out, _ = self.read(FakeRuns([_run(7, "2026-11-15T00:05:00Z", attempt=2)], etag='W/"e3"'), after=300)
        self.assertEqual([(b["status"], b["runUrl"]) for _, b in out],
                         [("green", f"https://github.com/{REPO}/actions/runs/7/attempts/2")])

    def test_gh_failure_raises_and_keeps_state(self):
        self.read(FakeRuns([_run(1, "2026-11-15T00:05:00Z")]))
        before = json.dumps(self.ctx.state["guard"], sort_keys=True)
        with self.assertRaises(RuntimeError):
            self.read(FakeRuns([], fail=True), after=300)
        self.assertEqual(json.dumps(self.ctx.state["guard"], sort_keys=True), before)

    def test_stuck_pending_run_does_not_hold_the_cursor(self):
        stuck = _run(1, "2026-11-14T17:00:00Z", status="queued")
        out, _ = self.read(FakeRuns([_run(2, "2026-11-15T00:20:00Z"), stuck]))
        self.assertEqual(self.ctx.state["guard"]["since"], "2026-11-15T00:20:00Z")

    def test_runs_beyond_one_page_are_counted_as_skipped(self):
        _, skipped = self.read(FakeRuns([_run(1, "2026-11-15T00:05:00Z")], total=80))
        self.assertEqual(skipped, 79)


class MatchTest(unittest.TestCase):
    def test_workflow_path_or_file_name_maps_to_check_cards(self):
        res = [(".github/workflows/eval-ci.yml", {"runUrl": "u1"}), (".github/workflows/boards-ci.yml", {"runUrl": "u2"})]
        cards = [{"taskId": "a", "permanenceParams": {"guard": {"kind": "ci", "ref": ".github/workflows/eval-ci.yml"}}},
                 {"taskId": "b", "permanenceParams": {"guard": {"kind": "ci", "ref": "eval-ci.yml"}}},
                 {"taskId": "c", "permanenceParams": {"guard": {"kind": "script", "ref": "eval-ci.yml"}}},
                 {"taskId": "d", "permanenceParams": None},
                 {"taskId": "e", "permanenceParams": {"guard": {"kind": "ci", "ref": "ci.yml"}}}]
        self.assertEqual(guard_source.match(res, cards), [("a", {"runUrl": "u1"}), ("b", {"runUrl": "u1"})])

    def test_summary_is_cut_to_the_route_limit(self):
        run = {"status": "completed", "conclusion": "success", "attempt": 1, "url": "u", "name": "x" * 600,
               "number": 1, "sha": "a" * 40, "updated": "2026-11-15T00:00:00Z"}
        self.assertEqual(len(guard_source.to_guard_run(run, BRANCH)["summary"]), guard_source.SUMMARY_MAX)


if __name__ == "__main__":
    unittest.main()
