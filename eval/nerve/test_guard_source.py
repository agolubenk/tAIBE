# -*- coding: utf-8 -*-
"""Читатель прогонов сторожей (TB-45, S45-4b, спека v0.8): курсор, 304, ящик, порядок пары, коды ответа досок,
перечитывание красных, дайджест и события."""
import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import guard_source  # noqa: E402
import sources  # noqa: E402
from journal import DIGEST, NERVOUS  # noqa: E402

REPO, BRANCH = "o/r", "board-agents"
T0 = datetime(2026, 11, 15, 0, 30, tzinfo=timezone.utc)
ETAG = 'W/"e1"'
EVAL = ".github/workflows/eval-ci.yml"


def _run(rid, created, status="completed", conclusion="success", path=EVAL, attempt=1):
    return {"id": rid, "run_attempt": attempt, "path": path, "name": "eval CI", "run_number": rid,
            "status": status, "conclusion": conclusion if status == "completed" else None,
            "html_url": f"https://github.com/{REPO}/actions/runs/{rid}", "head_sha": "a" * 40,
            "created_at": created, "updated_at": created.replace(":00Z", ":59Z")}


def _ok(body, etag):
    return 0, f"HTTP/2.0 200 OK\nEtag: {etag}\r\nX-Other: 1\r\n\r\n{json.dumps(body)}", ""


class FakeGh:
    """Подмена sources.run для `gh api -i`: список прогонов ветки и один прогон по id; совпавший If-None-Match — 304."""

    def __init__(self, runs=(), etag=ETAG, total=None, fail=False, single=None):
        self.runs, self.etag, self.total, self.fail = list(runs), etag, total, fail
        self.single = single or {}          # {id: (прогон, etag)}
        self.calls = []

    def __call__(self, cmd, stdin=None, timeout=30):
        self.calls.append(list(cmd))
        if cmd[:3] != ["gh", "api", "-i"] or not cmd[-1].startswith(f"repos/{REPO}/actions/runs"):
            raise AssertionError(f"неожиданный вызов: {cmd}")
        if self.fail:
            return 1, "", "HTTP 502: Bad Gateway"
        sent = cmd[cmd.index("-H") + 1] if "-H" in cmd else ""
        if cmd[-1].startswith(f"repos/{REPO}/actions/runs/"):
            run, etag = self.single[int(cmd[-1].rsplit("/", 1)[1])]
            if sent == f"If-None-Match: {etag}":
                return 1, "HTTP/2.0 304 Not Modified\r\n\r\n", "gh: HTTP 304"
            return _ok(run, etag)
        if sent == f"If-None-Match: {self.etag}":
            return 1, "HTTP/2.0 304 Not Modified\r\nEtag: x\r\n\r\n", "gh: HTTP 304"
        return _ok({"total_count": self.total or len(self.runs), "workflow_runs": self.runs}, self.etag)


class FakePost:
    """Клиент досок: отвечает по очереди из answers, последний ответ повторяется."""

    def __init__(self, *answers):
        self.answers, self.bodies = list(answers) or [(200, {"matched": 1})], []

    def __call__(self, body):
        self.bodies.append(body)
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]


class Ctx:
    def __init__(self):
        self.now = T0
        self.state = {}
        self.events = []

    def emit(self, key, kind, cls, to, text, src=""):
        if any(e[0] == key for e in self.events):
            return False
        self.events.append((key, kind, cls, sorted(to), text))
        return True


class Base(unittest.TestCase):
    def setUp(self):
        self._run = sources.run
        self.addCleanup(setattr, sources, "run", self._run)
        self.ctx = Ctx()

    def at(self, after):
        self.ctx.now = T0 + timedelta(seconds=after)

    def read(self, fake, after=0):
        sources.run = fake
        self.at(after)
        return guard_source.read_results(self.ctx, REPO, BRANCH)

    def poll(self, fake, post, after=0):
        sources.run = fake
        self.at(after)
        return guard_source.poll(self.ctx, REPO, BRANCH, post)

    def drain(self, post, after=0):
        self.at(after)
        return guard_source.drain(self.ctx, post)

    def queue(self, *runs):
        st = guard_source._state(self.ctx)
        for r in runs:
            guard_source._queue(st, guard_source._parse(r), REPO, BRANCH)

    @property
    def st(self):
        return self.ctx.state["guard"]

    def outbox(self):
        return [(e["body"]["runUrl"].split("/runs/", 1)[1], e["body"]["status"]) for e in self.st["outbox"]]

    def kinds(self):
        return [(e[1], e[2], e[3]) for e in self.ctx.events]


class ReadResultsTest(Base):
    def query(self, call):
        return call[-1].split("?", 1)[1]

    def test_first_read_takes_last_hour_and_queues_results_in_pair_order(self):
        fake = FakeGh([_run(3, "2026-11-15T00:20:00Z", conclusion="failure"),
                       _run(2, "2026-11-15T00:10:00Z", conclusion="cancelled"),
                       _run(6, "2026-11-15T00:12:00Z", conclusion="action_required"),
                       _run(8, "2026-11-15T00:14:00Z", conclusion="stale"),
                       _run(1, "2026-11-15T00:05:00Z")])
        self.assertEqual(self.read(fake), (2, 0))
        self.assertIn("created=%3E%3D2026-11-14T23%3A30%3A00Z", self.query(fake.calls[0]))
        self.assertIn("branch=board-agents", self.query(fake.calls[0]))
        self.assertEqual(self.outbox(), [("1", "green"), ("3", "red")])
        self.assertEqual(self.st["outbox"][1]["body"], {
            "repo": REPO, "path": EVAL, "runUrl": f"https://github.com/{REPO}/actions/runs/3", "status": "red",
            "ranAt": "2026-11-15T00:20:59Z", "runCreatedAt": "2026-11-15T00:20:00Z", "attempt": 1,
            "runId": 3, "summary": "eval CI #3: failure на aaaaaaaaa (board-agents)"})
        self.assertEqual(self.st["since"], "2026-11-15T00:20:00Z")

    def test_pending_run_holds_the_cursor_and_is_queued_once_done(self):
        self.read(FakeGh([_run(4, "2026-11-15T00:25:00Z"), _run(5, "2026-11-15T00:15:00Z", status="in_progress")]))
        self.assertEqual(self.outbox(), [("4", "green")])
        self.assertEqual(self.st["since"], "2026-11-15T00:15:00Z")
        fake = FakeGh([_run(4, "2026-11-15T00:25:00Z"), _run(5, "2026-11-15T00:15:00Z", conclusion="failure")],
                      etag='W/"e2"')
        self.read(fake, after=300)
        self.assertIn("created=%3E%3D2026-11-15T00%3A15%3A00Z", self.query(fake.calls[0]))
        self.assertEqual(self.outbox(), [("5", "red"), ("4", "green")])
        self.assertEqual((self.st["since"], sorted(self.st["seen"])), ("2026-11-15T00:25:00Z", ["4:1"]))

    def test_cursor_is_the_oldest_pending_run(self):
        runs = [{"status": "completed", "created": "2026-11-15T00:25:00Z"},
                {"status": "in_progress", "created": "2026-11-15T00:20:00Z"},
                {"status": "queued", "created": "2026-11-15T00:10:00Z"}]
        self.assertEqual(guard_source.next_since(runs, "2026-11-15T00:00:00Z", T0), "2026-11-15T00:10:00Z")
        self.assertEqual(guard_source.next_since([], "2026-11-15T00:05:00Z", T0), "2026-11-15T00:05:00Z")

    def test_same_query_goes_with_etag_and_304_changes_nothing(self):
        runs = [_run(1, "2026-11-15T00:05:00Z")]
        self.read(FakeGh(runs, etag='W/"e0"'))   # курсор сдвинулся: etag того запроса к новому не подходит
        second = FakeGh(runs)
        self.read(second, after=300)
        self.assertNotIn("-H", second.calls[0])
        before = {k: v for k, v in self.st.items() if k != "at"}
        fake = FakeGh([])                         # тело на 304 не читается
        self.assertEqual(self.read(fake, after=600), (0, 0))
        self.assertEqual(fake.calls[0][3:5], ["-H", f"If-None-Match: {ETAG}"])
        st = dict(self.st)
        self.assertEqual(st.pop("at"), "2026-11-15T00:40:00Z")
        self.assertEqual(st, before)

    def test_unsent_run_waits_in_the_outbox_not_in_a_reread(self):
        """N3: после отказа досок курсор и ETag уже сдвинуты, а прогон не потерян — он в ящике."""
        runs = [_run(1, "2026-11-15T00:05:00Z")]
        self.assertEqual(self.poll(FakeGh(runs), FakePost((503, None))), 0)
        self.assertEqual((self.st["since"], len(self.st["outbox"])), ("2026-11-15T00:05:00Z", 1))
        post = FakePost((200, {"matched": 1}))
        self.poll(FakeGh(runs), post, after=300)
        self.assertEqual([b["runUrl"][-1] for b in post.bodies], ["1"])
        self.assertEqual(self.st["outbox"], [])
        fake = FakeGh(runs)
        self.poll(fake, post, after=600)
        self.assertEqual(fake.calls[0][3:5], ["-H", f"If-None-Match: {ETAG}"])

    def test_repeat_read_does_not_requeue_a_seen_run(self):
        runs = [_run(1, "2026-11-15T00:05:00Z")]
        self.read(FakeGh(runs))
        self.assertEqual(self.read(FakeGh(runs, etag='W/"e9"'), after=300), (0, 0))
        self.assertEqual(len(self.st["outbox"]), 1)

    def test_rerun_attempt_is_a_new_run_with_its_own_url(self):
        self.read(FakeGh([_run(7, "2026-11-15T00:05:00Z", conclusion="failure")]))
        self.read(FakeGh([_run(7, "2026-11-15T00:05:00Z", attempt=2)], etag='W/"e3"'), after=300)
        self.assertEqual(self.outbox(), [("7", "red"), ("7/attempts/2", "green")])
        self.assertEqual(self.st["outbox"][1]["body"]["attempt"], 2)

    def test_gh_failure_raises_and_keeps_state(self):
        self.read(FakeGh([_run(1, "2026-11-15T00:05:00Z")]))
        before = json.dumps(self.st, sort_keys=True)
        with self.assertRaises(RuntimeError):
            self.read(FakeGh([], fail=True), after=300)
        self.assertEqual(json.dumps(self.st, sort_keys=True), before)

    def test_stuck_pending_run_does_not_hold_the_cursor(self):
        self.read(FakeGh([_run(2, "2026-11-15T00:20:00Z"), _run(1, "2026-11-14T17:00:00Z", status="queued")]))
        self.assertEqual(self.st["since"], "2026-11-15T00:20:00Z")

    def test_runs_beyond_one_page_are_counted_and_reported_once(self):
        fake = FakeGh([_run(1, "2026-11-15T00:05:00Z")], total=80)
        self.assertEqual(self.read(fake)[1], 79)
        self.ctx.state.clear()
        self.poll(fake, FakePost())
        self.poll(FakeGh([], etag='W/"x"'), FakePost(), after=300)
        skipped = [e for e in self.ctx.events if e[1] == "guard.skipped"]
        self.assertEqual(len(skipped), 1)
        self.assertEqual(skipped[0][2:4], (DIGEST, ["coord"]))
        self.assertIn("79", skipped[0][4])


class BodyTest(Base):
    def test_body_has_the_v08_fields_and_no_source(self):
        self.queue(_run(7, "2026-11-15T00:05:00Z", attempt=2))
        b = self.st["outbox"][0]["body"]
        self.assertEqual(sorted(b), ["attempt", "path", "ranAt", "repo", "runCreatedAt", "runId", "runUrl", "status",
                                     "summary"])
        self.assertEqual((b["runId"], b["attempt"], b["runCreatedAt"], b["ranAt"]),
                         (7, 2, "2026-11-15T00:05:00Z", "2026-11-15T00:05:59Z"))
        self.assertEqual(b["runUrl"], f"https://github.com/{REPO}/actions/runs/7/attempts/2")

    def test_path_keeps_the_ref_suffix_for_the_server(self):
        self.queue(_run(1, "2026-11-15T00:05:00Z", path=".github/workflows/build.yml@main"))
        self.assertEqual(self.st["outbox"][0]["body"]["path"], ".github/workflows/build.yml@main")

    def test_same_pair_is_ordered_by_run_id(self):
        """N11: push и schedule в одну секунду дают одинаковую пару — третий ключ порядка id прогона."""
        self.queue(_run(9, "2026-11-15T00:05:00Z"), _run(4, "2026-11-15T00:05:00Z"),
                   _run(9, "2026-11-15T00:05:00Z", attempt=2), _run(2, "2026-11-15T00:01:00Z"))
        self.assertEqual([(e["id"], e["body"]["attempt"]) for e in self.st["outbox"]], [(2, 1), (4, 1), (9, 1), (9, 2)])

    def test_summary_is_cut_by_utf16_units(self):
        self.assertEqual(len(guard_source.cut_utf16("x" * 600)), guard_source.SUMMARY_MAX)
        self.assertEqual(guard_source.cut_utf16("я" * 600), "я" * 500)
        cut = guard_source.cut_utf16("x" * 499 + "😀" + "y")    # эмодзи — 2 единицы UTF-16, на границе не режется
        self.assertEqual(cut, "x" * 499)
        self.assertEqual(guard_source.cut_utf16("x" * 498 + "😀"), "x" * 498 + "😀")
        run = guard_source._parse(_run(1, "2026-11-15T00:05:00Z"))
        run["name"] = "😀" * 300
        self.assertEqual(len(guard_source.to_body(run, REPO, BRANCH)["summary"].encode("utf-16-le")), 1000)


class DrainTest(Base):
    def setUp(self):
        super().setUp()
        self.queue(_run(1, "2026-11-15T00:05:00Z"), _run(2, "2026-11-15T00:10:00Z", conclusion="failure"),
                   _run(3, "2026-11-15T00:15:00Z", path=".github/workflows/checks-ci.yml"))

    def test_accepted_runs_leave_the_outbox_in_pair_order(self):
        post = FakePost()
        self.assertEqual(self.drain(post), 3)
        self.assertEqual([b["runUrl"][-1] for b in post.bodies], ["1", "2", "3"])
        self.assertEqual(self.st["outbox"], [])
        self.assertEqual(sorted(self.st["hit"]), [".github/workflows/checks-ci.yml", EVAL])
        self.assertEqual(self.ctx.events, [])

    def test_never_matched_workflows_go_to_one_digest_line_a_day(self):
        self.drain(FakePost((200, {"matched": 0})))
        self.queue(_run(4, "2026-11-15T00:20:00Z", path=".github/workflows/build.yml@main"))
        self.drain(FakePost((200, {"matched": 0})), after=3600)
        guard_source.flush_quiet(self.ctx)
        self.assertEqual(self.ctx.events, [])
        self.at(86400)
        guard_source.flush_quiet(self.ctx)
        guard_source.flush_quiet(self.ctx)
        self.assertEqual(self.kinds(), [("guard.quiet", DIGEST, ["coord"])])
        self.assertIn("(3): .github/workflows/build.yml, .github/workflows/checks-ci.yml, " + EVAL,
                      self.ctx.events[0][4])
        self.assertNotIn("quiet", self.st)

    def test_path_that_matched_before_gives_one_nervous_event_then_the_digest(self):
        self.drain(FakePost())
        self.queue(_run(5, "2026-11-15T00:25:00Z"), _run(6, "2026-11-15T00:26:00Z"))
        self.drain(FakePost((200, {"matched": 0})))
        self.assertEqual(self.kinds(), [("guard.unmatched", NERVOUS, ["coord"])])
        self.assertIn("/runs/5", self.ctx.events[0][4])
        self.assertNotIn(EVAL, self.st["hit"])
        self.assertEqual(self.st["quiet"]["paths"], [EVAL])

    def test_bad_body_is_dropped_with_one_event_and_the_rest_goes(self):
        post = FakePost((422, {"error": "summary"}), (400, None), (200, {"matched": 1}))
        self.assertEqual(self.drain(post), 1)
        self.assertEqual(self.st["outbox"], [])
        self.assertEqual([e[0] for e in self.ctx.events], ["guard:drop:422:2026-11-15", "guard:drop:400:2026-11-15"])
        self.assertEqual(self.ctx.events[0][2:4], (NERVOUS, ["coord"]))
        self.assertIn('"summary"', self.ctx.events[0][4])

    def test_413_is_dropped(self):
        self.drain(FakePost((413, None), (200, {"matched": 1})))
        self.assertEqual(self.outbox(), [])
        self.assertEqual(self.kinds(), [("guard.drop", NERVOUS, ["coord"])])

    def test_denied_key_keeps_the_outbox_with_one_event_per_episode(self):
        post = FakePost((401, None))
        self.assertEqual(self.drain(post), 0)
        self.assertEqual(len(self.st["outbox"]), 3)
        self.drain(post, after=60)                     # повтор не раньше GUARD_EVERY
        self.assertEqual(len(post.bodies), 1)
        self.drain(FakePost((403, None)), after=300)
        self.assertEqual(self.kinds(), [("guard.denied", NERVOUS, ["coord", "release"])])
        self.assertIn("401", self.ctx.events[0][4])
        self.drain(FakePost(), after=600)
        self.assertEqual(self.st["outbox"], [])
        self.assertNotIn("denied", self.st)
        self.assertEqual(self.kinds()[1], ("guard.denied", DIGEST, ["coord", "release"]))
        self.assertIn("снова принимают", self.ctx.events[1][4])

    def test_unknown_workspace_tells_coord(self):
        self.drain(FakePost((404, None)))
        self.assertEqual(self.kinds(), [("guard.denied", NERVOUS, ["coord"])])
        self.assertEqual(len(self.st["outbox"]), 3)

    def test_transient_failure_retries_later_without_raising(self):
        for answer in ((429, None), (502, None), (0, None), (409, None)):
            self.st.pop("retry_at", None)
            self.st.pop("fail", None)
            post = FakePost(answer)
            self.assertEqual(self.drain(post), 0)
            self.assertEqual(len(self.st["outbox"]), 3)
            self.assertEqual(self.drain(post, after=GUARD_EVERY_MINUS_1), 0)
            self.assertEqual(len(post.bodies), 1)
            self.assertEqual("fail" in self.st, answer[0] != 429)     # 429 — доски ответили, это не сбой
        self.assertEqual(self.ctx.events, [])

    def test_failures_longer_than_two_reads_give_one_event_per_episode(self):
        every = guard_source.GUARD_EVERY
        self.drain(FakePost((503, None)))
        self.drain(FakePost((0, None)), after=every)
        self.drain(FakePost((200, {"matched": 1}), (502, None)), after=2 * every)    # 2xx обрывает серию
        self.assertEqual((self.st["fail"]["n"], self.ctx.events), (1, []))
        self.drain(FakePost((502, None)), after=3 * every)
        self.assertEqual(self.ctx.events, [])
        self.drain(FakePost((409, None)), after=4 * every)
        self.assertEqual(self.kinds(), [("guard.fail", NERVOUS, ["coord"])])
        self.assertIn("3 чтения подряд с 00:40 (последний ответ: 409); 2 прогонов", self.ctx.events[0][4])
        self.drain(FakePost((0, None)), after=5 * every)                            # тот же эпизод
        self.assertEqual(len(self.ctx.events), 1)
        self.drain(FakePost(), after=6 * every)
        self.assertEqual(self.kinds()[1], ("guard.fail", DIGEST, ["coord"]))
        self.assertIn("снова отвечают", self.ctx.events[1][4])
        self.assertEqual((self.st["outbox"], "fail" in self.st), ([], False))

    def test_one_pass_sends_no_more_than_drain_max(self):
        self.queue(*[_run(100 + i, "2026-11-15T00:20:00Z") for i in range(guard_source.DRAIN_MAX)])
        post = FakePost()
        self.assertEqual(self.drain(post), guard_source.DRAIN_MAX)
        self.assertEqual(len(self.st["outbox"]), 3)

    def test_overflow_drops_the_oldest_with_one_event_a_day(self):
        st = self.st
        self.queue(*[_run(100 + i, "2026-11-15T00:20:00Z") for i in range(guard_source.OUTBOX_MAX)])
        guard_source._trim(self.ctx, st)
        guard_source._trim(self.ctx, st)
        self.assertEqual(len(st["outbox"]), guard_source.OUTBOX_MAX)
        self.assertEqual(st["outbox"][0]["id"], 100)
        self.assertEqual(self.kinds(), [("guard.overflow", DIGEST, ["coord", "release"])])


GUARD_EVERY_MINUS_1 = guard_source.GUARD_EVERY - 1


class RecheckTest(Base):
    def red_accepted(self):
        self.queue(_run(7, "2026-11-15T00:05:00Z", conclusion="failure"))
        self.drain(FakePost())

    def test_matched_red_rerun_is_read_by_id_and_queued(self):
        self.red_accepted()
        self.assertEqual(self.st["reds"][EVAL]["id"], 7)
        fake = FakeGh(single={7: (_run(7, "2026-11-15T00:05:00Z", attempt=2), 'W/"r2"')})
        sources.run = fake
        self.assertEqual(guard_source.recheck(self.ctx, REPO, BRANCH), 1)
        self.assertEqual(fake.calls[0][-1], f"repos/{REPO}/actions/runs/7")
        self.assertEqual(self.outbox(), [("7/attempts/2", "green")])
        self.assertEqual(guard_source.recheck(self.ctx, REPO, BRANCH), 0)    # тот же etag — 304
        self.assertEqual(fake.calls[1][3:5], ["-H", 'If-None-Match: W/"r2"'])
        self.drain(FakePost())
        self.assertNotIn(EVAL, self.st["reds"])

    def test_rerun_in_progress_is_queued_once_it_ends(self):
        self.red_accepted()
        fake = FakeGh(single={7: (_run(7, "2026-11-15T00:05:00Z", attempt=2, status="in_progress"), 'W/"p"')})
        sources.run = fake
        self.assertEqual(guard_source.recheck(self.ctx, REPO, BRANCH), 0)
        fake.single[7] = (_run(7, "2026-11-15T00:05:00Z", attempt=2, conclusion="failure"), 'W/"d"')
        self.assertEqual(guard_source.recheck(self.ctx, REPO, BRANCH), 1)
        self.drain(FakePost())
        self.assertEqual(self.st["reds"][EVAL]["attempt"], 2)

    def test_old_red_is_not_reread(self):
        self.red_accepted()
        sources.run = FakeGh()
        self.at(7 * 3600)
        self.assertEqual(guard_source.recheck(self.ctx, REPO, BRANCH), 0)
        self.assertEqual(sources.run.calls, [])
        self.assertEqual(self.st["reds"], {})

    def test_only_the_newest_matched_red_of_a_path_is_kept(self):
        self.queue(_run(8, "2026-11-15T00:10:00Z", conclusion="failure"), _run(9, "2026-11-15T00:12:00Z"))
        self.drain(FakePost())
        self.assertEqual(self.st["reds"], {})                       # новее красного пришёл зелёный
        self.queue(_run(10, "2026-11-15T00:20:00Z", conclusion="failure"))
        self.drain(FakePost())
        self.queue(_run(5, "2026-11-15T00:01:00Z"))                 # старый зелёный после нового красного
        self.drain(FakePost())
        self.assertEqual(self.st["reds"][EVAL]["id"], 10)

    def test_unmatched_red_is_not_reread(self):
        self.queue(_run(7, "2026-11-15T00:05:00Z", conclusion="failure"))
        self.drain(FakePost((200, {"matched": 0})))
        self.assertEqual(self.st["reds"], {})


class PollTest(Base):
    def test_reads_no_more_often_than_guard_every_but_drains_every_pass(self):
        self.poll(FakeGh([]), FakePost())
        fake = FakeGh([], etag='W/"n"')
        self.queue(_run(1, "2026-11-15T00:05:00Z"))
        post = FakePost()
        self.assertEqual(self.poll(fake, post, after=guard_source.GUARD_EVERY - 1), 1)
        self.assertEqual(fake.calls, [])
        self.poll(fake, post, after=guard_source.GUARD_EVERY)
        self.assertEqual(len(fake.calls), 1)

    def test_read_recheck_and_send_in_one_pass(self):
        self.queue(_run(7, "2026-11-15T00:05:00Z", conclusion="failure"))
        self.drain(FakePost())
        self.st["at"] = guard_source._iso(T0 - timedelta(seconds=guard_source.GUARD_EVERY))
        fake = FakeGh([_run(11, "2026-11-15T00:28:00Z")],
                      single={7: (_run(7, "2026-11-15T00:05:00Z", attempt=2), 'W/"r"')})
        post = FakePost()
        self.assertEqual(self.poll(fake, post), 2)
        self.assertEqual([b["runUrl"].split("/runs/")[1] for b in post.bodies], ["7/attempts/2", "11"])


if __name__ == "__main__":
    unittest.main()
